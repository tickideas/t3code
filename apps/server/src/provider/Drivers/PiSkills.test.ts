import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { discoverPiSkills } from "./PiSkills.ts";

const encodeTrustStore = Schema.encodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Boolean)),
);

const writeSkill = Effect.fn(function* (
  skillsDir: string,
  directoryName: string,
  contents: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillDir = path.join(skillsDir, directoryName);
  yield* fs.makeDirectory(skillDir, { recursive: true });
  yield* fs.writeFileString(path.join(skillDir, "SKILL.md"), contents);
});

/**
 * Record the trust decision Pi would have stored for a workspace. Pi keys
 * `trust.json` by canonical path, so the workspace has to exist before the
 * key is derived.
 */
const writeTrustDecision = Effect.fn(function* (
  home: string,
  workspace: string,
  decision: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(workspace, { recursive: true });
  const canonical = yield* fs
    .realPath(workspace)
    .pipe(Effect.orElseSucceed(() => path.resolve(workspace)));
  const agentDir = path.join(home, ".pi", "agent");
  yield* fs.makeDirectory(agentDir, { recursive: true });
  const contents = yield* encodeTrustStore({ [canonical]: decision }).pipe(Effect.orDie);
  yield* fs.writeFileString(path.join(agentDir, "trust.json"), contents);
});

const isolatedEnvironment = (home: string) => ({
  HOME: home,
  PI_CODING_AGENT_DIR: undefined,
});

it.layer(NodeServices.layer)("discoverPiSkills", (it) => {
  it.effect("discovers user and project skills with frontmatter metadata", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-skills-" });
      const home = path.join(tempDir, "home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(home, ".pi", "agent", "skills"),
        "review",
        ["---", "name: review", "description: Review the change.", "---", "", "# Review"].join(
          "\n",
        ),
      );
      yield* writeSkill(
        path.join(home, ".agents", "skills"),
        "browser",
        [
          "---",
          "name: agent-browser",
          "description: Drive a browser.",
          "---",
          "",
          "# Browser",
        ].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".pi", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Deploy the app.", "---", "", "# Deploy"].join("\n"),
      );
      yield* writeTrustDecision(home, workspace, true);

      const skills = yield* discoverPiSkills(workspace, isolatedEnvironment(home));

      assert.deepEqual(skills, [
        {
          name: "agent-browser",
          path: path.join(home, ".agents", "skills", "browser", "SKILL.md"),
          enabled: true,
          scope: "user",
          description: "Drive a browser.",
        },
        {
          name: "deploy",
          path: path.join(workspace, ".pi", "skills", "deploy", "SKILL.md"),
          enabled: true,
          scope: "project",
          description: "Deploy the app.",
        },
        {
          name: "review",
          path: path.join(home, ".pi", "agent", "skills", "review", "SKILL.md"),
          enabled: true,
          scope: "user",
          description: "Review the change.",
        },
      ]);
    }),
  );

  it.effect("prefers project skills over user skills on name collisions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-skills-" });
      const home = path.join(tempDir, "home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(home, ".pi", "agent", "skills"),
        "deploy",
        ["---", "name: deploy", "description: User deploy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".pi", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Project deploy.", "---"].join("\n"),
      );
      yield* writeTrustDecision(home, workspace, true);

      const skills = yield* discoverPiSkills(workspace, isolatedEnvironment(home));

      assert.equal(skills.length, 1);
      assert.equal(skills[0]?.scope, "project");
      assert.equal(skills[0]?.description, "Project deploy.");
    }),
  );

  it.effect("omits project skills until Pi has trusted the workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-skills-" });
      const home = path.join(tempDir, "home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(home, ".pi", "agent", "skills"),
        "review",
        ["---", "name: review", "description: Review the change.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".pi", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Deploy the app.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".agents", "skills"),
        "hostile",
        ["---", "name: hostile", "description: From an untrusted repo.", "---"].join("\n"),
      );

      // No trust store at all: Pi would prompt rather than load these.
      const untrusted = yield* discoverPiSkills(workspace, isolatedEnvironment(home));
      assert.deepEqual(
        untrusted.map((skill) => skill.name),
        ["review"],
      );

      // An explicit denial keeps them out too.
      yield* writeTrustDecision(home, workspace, false);
      const denied = yield* discoverPiSkills(workspace, isolatedEnvironment(home));
      assert.deepEqual(
        denied.map((skill) => skill.name),
        ["review"],
      );

      yield* writeTrustDecision(home, workspace, true);
      const trusted = yield* discoverPiSkills(workspace, isolatedEnvironment(home));
      assert.deepEqual(
        trusted.map((skill) => skill.name),
        ["deploy", "hostile", "review"],
      );
    }),
  );

  it.effect("inherits a trust decision recorded on a parent directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-skills-" });
      const home = path.join(tempDir, "home");
      const parent = path.join(tempDir, "workspaces");
      const workspace = path.join(parent, "app");

      yield* writeSkill(
        path.join(workspace, ".pi", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Deploy the app.", "---"].join("\n"),
      );
      yield* writeTrustDecision(home, parent, true);

      const skills = yield* discoverPiSkills(workspace, isolatedEnvironment(home));

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["deploy"],
      );
    }),
  );

  it.effect("loads nested SKILL.md files and root markdown in Pi-native roots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-skills-" });
      const home = path.join(tempDir, "home");
      const workspace = path.join(tempDir, "workspace");
      const userSkills = path.join(home, ".pi", "agent", "skills");
      const projectSkills = path.join(workspace, ".pi", "skills");

      yield* writeSkill(
        path.join(userSkills, "nested"),
        "transcribe",
        ["---", "name: transcribe", "description: Transcribe audio.", "---"].join("\n"),
      );
      yield* fs.makeDirectory(userSkills, { recursive: true });
      yield* fs.writeFileString(
        path.join(userSkills, "commit.md"),
        ["---", "name: commit", "description: Write a commit message.", "---"].join("\n"),
      );
      yield* fs.makeDirectory(path.join(workspace, ".agents", "skills"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workspace, ".agents", "skills", "ignored.md"),
        ["---", "name: ignored-root", "description: Should not load.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(projectSkills, "docs"),
        "docx",
        ["---", "name: docx", "description: Edit Word documents.", "---"].join("\n"),
      );
      yield* writeTrustDecision(home, workspace, true);

      const skills = yield* discoverPiSkills(workspace, isolatedEnvironment(home));

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["commit", "docx", "transcribe"],
      );
      assert.equal(skills.find((skill) => skill.name === "commit")?.scope, "user");
      assert.equal(skills.find((skill) => skill.name === "docx")?.scope, "project");
    }),
  );

  it.effect("names unnamed skills after the directory holding the file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-skills-" });
      const home = path.join(tempDir, "home");
      const agentSkills = path.join(home, ".pi", "agent", "skills");

      yield* writeSkill(
        agentSkills,
        "release-notes",
        ["---", "description: Draft release notes.", "---"].join("\n"),
      );
      yield* fs.makeDirectory(agentSkills, { recursive: true });
      yield* fs.writeFileString(
        path.join(agentSkills, "commit.md"),
        ["---", "description: Write a commit message.", "---"].join("\n"),
      );

      const skills = yield* discoverPiSkills(undefined, isolatedEnvironment(home));

      // Pi derives the fallback from the containing directory for every skill
      // file, so a root-level `commit.md` is named after its root, not "commit".
      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["release-notes", "skills"],
      );
      assert.equal(
        skills.find((skill) => skill.name === "skills")?.path,
        path.join(agentSkills, "commit.md"),
      );
    }),
  );

  it.effect("scans ancestor .agents/skills up to the git root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-skills-" });
      const home = path.join(tempDir, "home");
      const repo = path.join(tempDir, "repo");
      const workspace = path.join(repo, "apps", "web");

      yield* fs.makeDirectory(path.join(repo, ".git"), { recursive: true });
      yield* writeSkill(
        path.join(repo, ".agents", "skills"),
        "repo-skill",
        ["---", "name: repo-skill", "description: From the repo root.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(tempDir, ".agents", "skills"),
        "outside",
        ["---", "name: outside", "description: Above the git root.", "---"].join("\n"),
      );
      yield* writeTrustDecision(home, workspace, true);

      const skills = yield* discoverPiSkills(workspace, isolatedEnvironment(home));

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["repo-skill"],
      );
      assert.equal(skills[0]?.scope, "project");
    }),
  );

  it.effect("skips skills without a description and malformed frontmatter", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-skills-" });
      const home = path.join(tempDir, "home");
      const skillsDir = path.join(home, ".pi", "agent", "skills");

      yield* writeSkill(
        skillsDir,
        "no-description",
        ["---", "name: no-description", "---"].join("\n"),
      );
      yield* writeSkill(skillsDir, "no-frontmatter", "# Just a heading\n");
      yield* writeSkill(skillsDir, "broken-yaml", "---\nname: [unclosed\n---\n");
      yield* writeSkill(
        skillsDir,
        "valid",
        ["---", "name: valid", "description: A real skill.", "---"].join("\n"),
      );

      const skills = yield* discoverPiSkills(undefined, isolatedEnvironment(home));

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["valid"],
      );
    }),
  );

  it.effect("honors PI_CODING_AGENT_DIR from the environment", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-skills-" });
      const home = path.join(tempDir, "home");
      const agentDir = path.join(tempDir, "custom-agent");

      yield* writeSkill(
        path.join(home, ".pi", "agent", "skills"),
        "default-skill",
        ["---", "name: default-skill", "description: From default home.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(agentDir, "skills"),
        "custom-skill",
        ["---", "name: custom-skill", "description: From custom agent dir.", "---"].join("\n"),
      );

      const skills = yield* discoverPiSkills(undefined, {
        HOME: home,
        PI_CODING_AGENT_DIR: agentDir,
      });

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["custom-skill"],
      );
    }),
  );

  it.effect("returns an empty list when no skill roots exist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-skills-" });
      const home = path.join(tempDir, "missing-home");

      const skills = yield* discoverPiSkills(
        path.join(tempDir, "missing-workspace"),
        isolatedEnvironment(home),
      );

      assert.deepEqual(skills, []);
    }),
  );
});
