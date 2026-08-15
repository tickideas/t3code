import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { PiSettings } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { PiRpcCommandError, PiRpcProtocolError, type PiRpcClient } from "../pi/PiRpcClient.ts";
import { checkPiProviderStatus } from "./PiProvider.ts";

const assert: typeof NodeAssert = NodeAssert;
const settings = Schema.decodeSync(PiSettings)({ binaryPath: "fake-pi" });
const isolatedEnvironment = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-provider-" });
  return { HOME: path.join(tempDir, "home") } satisfies NodeJS.ProcessEnv;
});

const unusedClientMethods = {
  events: Stream.empty,
  setModel: () => Effect.die("unused"),
  setThinkingLevel: () => Effect.die("unused"),
  prompt: () => Effect.die("unused"),
  abort: () => Effect.die("unused"),
  close: () => Effect.void,
} satisfies Omit<PiRpcClient, "getAvailableModels" | "getState">;

it.effect("maps Pi RPC inventory into selectable models", () =>
  Effect.gen(function* () {
    const environment = { ...(yield* isolatedEnvironment()), PI_TOKEN: "test" };
    const snapshot = yield* checkPiProviderStatus(settings, environment, (options) =>
      Effect.succeed({
        ...unusedClientMethods,
        getState: () =>
          Effect.succeed({
            model: { provider: "openai compatible", id: "gpt/5", reasoning: true },
            thinkingLevel: "medium" as const,
          }),
        getAvailableModels: () =>
          Effect.succeed({
            models: [
              { provider: "openai compatible", id: "gpt/5", name: " GPT Five ", reasoning: true },
            ],
          }),
      } satisfies PiRpcClient).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            assert.equal(options.command, "fake-pi");
            assert.equal(options.env?.PI_TOKEN, "test");
            assert.equal(options.args?.includes("--no-session"), true);
            for (const arg of [
              "--no-context-files",
              "--no-extensions",
              "--no-skills",
              "--no-prompt-templates",
            ])
              assert.equal(options.args?.includes(arg), false);
          }),
        ),
      ),
    );

    assert.equal(snapshot.status, "ready");
    assert.equal(snapshot.auth.status, "authenticated");
    assert.equal(snapshot.models[0]?.slug, "openai%20compatible/gpt%2F5");
    assert.equal(snapshot.models[0]?.name, "GPT Five");
    assert.equal(snapshot.models[0]?.isDefault, true);
    assert.equal(snapshot.models[0]?.capabilities?.optionDescriptors?.[0]?.id, "thinkingLevel");
    assert.equal(snapshot.models[0]?.capabilities?.optionDescriptors?.[0]?.currentValue, "medium");
    assert.deepEqual(snapshot.skills, []);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports a binary missing error wrapped by the Pi RPC protocol as not installed", () =>
  Effect.gen(function* () {
    const missing = new PlatformError.SystemError({
      _tag: "NotFound",
      module: "ChildProcess",
      method: "spawn",
    });
    const snapshot = yield* checkPiProviderStatus(settings, yield* isolatedEnvironment(), () =>
      Effect.fail(new PiRpcProtocolError({ detail: "failed to spawn Pi RPC", cause: missing })),
    );

    assert.equal(snapshot.installed, false);
    assert.equal(snapshot.status, "error");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports discovery failure and does not spawn while disabled", () =>
  Effect.gen(function* () {
    let spawns = 0;
    const factory = () => {
      spawns += 1;
      return Effect.fail(
        new PiRpcCommandError({ command: "spawn", requestId: "test", detail: "inventory down" }),
      );
    };
    const environment = yield* isolatedEnvironment();
    const failed = yield* checkPiProviderStatus(settings, environment, factory);
    assert.equal(failed.status, "error");
    assert.match(failed.message ?? "", /^Pi model discovery failed:/);
    assert.deepEqual(failed.skills, []);

    const disabled = yield* checkPiProviderStatus(
      { ...settings, enabled: false },
      environment,
      factory,
    );
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.status, "disabled");
    assert.match(disabled.message ?? "", /disabled/);
    assert.equal(spawns, 1);
    assert.deepEqual(disabled.skills, []);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("attaches discovered Pi skills to the provider snapshot", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-provider-skills-" });
    const home = path.join(tempDir, "home");
    const workspace = path.join(tempDir, "workspace");
    const skillDir = path.join(home, ".pi", "agent", "skills", "review");
    yield* fs.makeDirectory(skillDir, { recursive: true });
    yield* fs.writeFileString(
      path.join(skillDir, "SKILL.md"),
      ["---", "name: review", "description: Review the change.", "---"].join("\n"),
    );

    const snapshot = yield* checkPiProviderStatus(
      settings,
      { HOME: home },
      () =>
        Effect.succeed({
          ...unusedClientMethods,
          getState: () => Effect.succeed({}),
          getAvailableModels: () => Effect.succeed({ models: [] }),
        } satisfies PiRpcClient),
      workspace,
    );

    assert.equal(snapshot.status, "warning");
    assert.deepEqual(snapshot.skills, [
      {
        name: "review",
        path: path.join(skillDir, "SKILL.md"),
        enabled: true,
        scope: "user",
        description: "Review the change.",
      },
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);
