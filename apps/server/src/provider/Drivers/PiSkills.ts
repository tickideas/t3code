/**
 * PiSkills — filesystem discovery of Pi skills for the `$` picker.
 *
 * Pi loads skills from `~/.pi/agent/skills` and `~/.agents/skills` (user),
 * plus `<cwd>/.pi/skills` and ancestor `.agents/skills` directories
 * (project). Directories containing `SKILL.md` are scanned recursively.
 * In the Pi-native roots, root-level `.md` files are skills too.
 * The provider snapshot scans the same locations the spawned CLI uses
 * so the composer `$` picker matches what Pi would actually load.
 *
 * Project roots are gated on Pi's trust store: Pi refuses project skills
 * from an untrusted workspace, so listing them would both advertise skills
 * the runtime will not load and surface untrusted repository content.
 *
 * @module provider/Drivers/PiSkills
 */
import * as NodeOS from "node:os";

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parse as parseYamlDocument } from "yaml";

import { expandHomePath } from "../../pathExpansion.ts";

type PiSkillScope = "user" | "project";
type PiSkillRootMode = "pi" | "agents";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const PI_TRUST_FILE_NAME = "trust.json";

// Pi's trust store maps a canonical project path to `true`, `false`, or
// `null`, and rejects anything else. A store we cannot decode is treated as
// "no decision" so a malformed file never widens what the picker shows.
const decodePiTrustStore = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.NullOr(Schema.Boolean))),
);

type SkillFrontmatter =
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" }
  | { readonly kind: "parsed"; readonly name?: string; readonly description?: string };

function parseSkillFrontmatter(contents: string): SkillFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) {
    return { kind: "missing" };
  }

  let parsed: unknown;
  try {
    parsed = parseYamlDocument(match[1] ?? "");
  } catch {
    return { kind: "malformed" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "malformed" };
  }

  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  return {
    kind: "parsed",
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
  };
}

function resolveHomePath(environment: NodeJS.ProcessEnv, path: Path.Path): string {
  const home = environment.HOME?.trim() ?? "";
  return home.length > 0 ? path.resolve(expandHomePath(home)) : NodeOS.homedir();
}

/**
 * Resolve the Pi agent directory the CLI would use: `PI_CODING_AGENT_DIR`
 * when set, otherwise `~/.pi/agent`. A relative env value is resolved
 * against the workspace cwd — the subprocess's own cwd.
 */
const resolvePiAgentDirPath = Effect.fn("resolvePiAgentDirPath")(function* (
  environment: NodeJS.ProcessEnv,
  cwd?: string,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const environmentAgentDir = environment[PI_AGENT_DIR_ENV]?.trim() ?? "";
  if (environmentAgentDir.length > 0) {
    const expanded = expandHomePath(environmentAgentDir);
    return cwd ? path.resolve(cwd, expanded) : path.resolve(expanded);
  }
  return path.join(resolveHomePath(environment, path), ".pi", "agent");
});

const collectAncestorAgentsSkillDirs = Effect.fn("collectAncestorAgentsSkillDirs")(function* (
  cwd: string,
): Effect.fn.Return<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directories: string[] = [];
  let directory = path.resolve(cwd);

  while (true) {
    directories.push(path.join(directory, ".agents", "skills"));
    const gitInfo = yield* fileSystem
      .stat(path.join(directory, ".git"))
      .pipe(Effect.orElseSucceed(() => undefined));
    if (gitInfo) {
      break;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }

  return directories;
});

/**
 * Read Pi's stored trust decision for a workspace.
 *
 * Pi walks from the canonicalized cwd upward and takes the nearest explicit
 * `true`/`false`; `null` entries are not decisions. An absent decision means
 * the user has not trusted the project, and Pi would prompt rather than load
 * project skills, so discovery stays conservative and reports untrusted.
 */
const resolvePiProjectTrust = Effect.fn("resolvePiProjectTrust")(function* (
  agentDirPath: string,
  cwd: string,
): Effect.fn.Return<boolean, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const decisions = yield* fileSystem
    .readFileString(path.join(agentDirPath, PI_TRUST_FILE_NAME))
    .pipe(
      Effect.flatMap(decodePiTrustStore),
      Effect.orElseSucceed(() => undefined),
    );
  if (decisions === undefined) {
    return false;
  }

  let directory = yield* fileSystem
    .realPath(cwd)
    .pipe(Effect.orElseSucceed(() => path.resolve(cwd)));
  while (true) {
    const decision = decisions[directory];
    if (typeof decision === "boolean") {
      return decision;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return false;
    }
    directory = parent;
  }
});

/**
 * Enumerate Pi skills from the user agent dir, shared agents roots, and
 * the workspace. Discovery is best-effort: unreadable roots and entries
 * Pi would refuse (missing description, malformed frontmatter) are
 * skipped so a broken skill never degrades the provider snapshot. On
 * name collisions the first match wins, matching Pi's scan order:
 * project `.pi`, then project `.agents` ancestors (cwd first), then
 * user `~/.pi/agent/skills`, then `~/.agents/skills`. Both project
 * tiers are dropped entirely unless Pi's trust store trusts the cwd.
 */
export const discoverPiSkills = Effect.fn("discoverPiSkills")(function* (
  cwd?: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolvedEnvironment = environment ?? process.env;
  const agentDirPath = yield* resolvePiAgentDirPath(resolvedEnvironment, cwd);
  const homePath = resolveHomePath(resolvedEnvironment, path);
  const userAgentsSkillsDir = path.join(homePath, ".agents", "skills");
  const projectTrusted = cwd !== undefined && (yield* resolvePiProjectTrust(agentDirPath, cwd));
  const projectAgentsSkillDirs =
    cwd && projectTrusted
      ? (yield* collectAncestorAgentsSkillDirs(cwd)).filter(
          (directory) => path.resolve(directory) !== path.resolve(userAgentsSkillsDir),
        )
      : [];

  const roots: ReadonlyArray<{
    directory: string;
    scope: PiSkillScope;
    mode: PiSkillRootMode;
  }> = [
    ...(cwd && projectTrusted
      ? [
          {
            directory: path.join(cwd, ".pi", "skills"),
            scope: "project" as const,
            mode: "pi" as const,
          },
        ]
      : []),
    ...projectAgentsSkillDirs.map((directory) => ({
      directory,
      scope: "project" as const,
      mode: "agents" as const,
    })),
    { directory: path.join(agentDirPath, "skills"), scope: "user", mode: "pi" },
    { directory: userAgentsSkillsDir, scope: "user", mode: "agents" },
  ];

  const skillsByName = new Map<string, ServerProviderSkill>();
  const seenFiles = new Set<string>();

  const considerSkillFile = (skillPath: string, scope: PiSkillScope) =>
    Effect.gen(function* () {
      const realPath = yield* fileSystem
        .realPath(skillPath)
        .pipe(Effect.orElseSucceed(() => skillPath));
      if (seenFiles.has(realPath)) {
        return;
      }

      const contents = yield* fileSystem
        .readFileString(skillPath)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (contents === undefined) {
        return;
      }

      const frontmatter = parseSkillFrontmatter(contents);
      if (frontmatter.kind === "malformed") {
        return;
      }

      const description = frontmatter.kind === "parsed" ? frontmatter.description : undefined;
      // Pi refuses skills with no description. Match that so the picker
      // does not advertise something the runtime will skip.
      if (!description) {
        return;
      }

      // Pi names an unnamed skill after the directory holding the file, for
      // root-level `.md` files as much as for `SKILL.md`. Trimming keeps a
      // whitespace-only directory name from reaching `TrimmedNonEmptyString`.
      const name =
        (frontmatter.kind === "parsed" ? frontmatter.name : undefined) ??
        path.basename(path.dirname(skillPath)).trim();
      if (!name || skillsByName.has(name)) {
        return;
      }

      seenFiles.add(realPath);
      skillsByName.set(name, {
        name,
        path: skillPath,
        enabled: true,
        scope,
        description,
      });
    });

  const visit = (
    directory: string,
    scope: PiSkillScope,
    includeRootMarkdown: boolean,
  ): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
      const entries = yield* fileSystem
        .readDirectory(directory)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      const skillMarkdownPath = path.join(directory, "SKILL.md");
      const skillMarkdownInfo = yield* fileSystem
        .stat(skillMarkdownPath)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (skillMarkdownInfo?.type === "File") {
        yield* considerSkillFile(skillMarkdownPath, scope);
        return;
      }

      for (const entry of [...entries].sort()) {
        if (entry.startsWith(".") || entry === "node_modules") {
          continue;
        }

        const fullPath = path.join(directory, entry);
        const info = yield* fileSystem.stat(fullPath).pipe(Effect.orElseSucceed(() => undefined));
        if (!info) {
          continue;
        }
        if (info.type === "Directory") {
          yield* visit(fullPath, scope, false);
          continue;
        }
        if (includeRootMarkdown && info.type === "File" && entry.endsWith(".md")) {
          yield* considerSkillFile(fullPath, scope);
        }
      }
    });

  for (const root of roots) {
    yield* visit(root.directory, root.scope, root.mode === "pi");
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});
