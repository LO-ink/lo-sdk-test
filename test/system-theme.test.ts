import test from "node:test";
import assert from "node:assert/strict";
import { systemThemeChecks } from "../web/system-theme.ts";
import type { Bridge } from "../web/bridges.ts";
import type { Interact } from "../web/interaction.ts";

function fixture() {
  let scheme: "light" | "dark" = "light";
  const routes = ["native", "compat"].map((id) => {
    let current = scheme;
    const listeners = new Set<() => void>();
    const bridge = {
      id,
      label: id,
      client: {
        adapter: { snapshot: () => ({ colorScheme: current }) },
        on: (_event: string, callback: () => void) => {
          listeners.add(callback);
          return () => listeners.delete(callback);
        },
      },
    } as unknown as Bridge;
    return {
      bridge,
      listeners,
      emit(next: typeof scheme) {
        current = next;
        for (const callback of listeners) callback();
      },
    };
  });
  return {
    routes,
    read: () => scheme,
    set: (next: typeof scheme) => {
      scheme = next;
    },
  };
}

test("one system-theme cycle validates both bridges independently and releases subscriptions", async () => {
  const f = fixture();
  let prompts = 0;
  const interact: Interact = async (request) => {
    prompts++;
    await request.action!("");
    for (const scheme of ["dark", "light"] as const) {
      f.set(scheme);
      for (const route of f.routes) route.emit(scheme);
    }
    return { decision: "yes" };
  };
  const checks = systemThemeChecks(
    f.routes.map((r) => r.bridge),
    interact,
    f.read,
  );
  for (const check of checks) {
    const result = await check.execute(new AbortController().signal);
    assert.equal(typeof result, "object");
    assert.equal((result as { state: string }).state, "passed");
  }
  assert.equal(prompts, 1);
  for (const route of f.routes) assert.equal(route.listeners.size, 0);
});

test("user confirmation and a successful legacy cycle cannot pass a native bridge without actual theme events", async () => {
  const f = fixture();
  const interact: Interact = async (request) => {
    await request.action!("");
    for (const scheme of ["dark", "light"] as const) {
      f.set(scheme);
      f.routes[1].emit(scheme);
    }
    return { decision: "yes" };
  };
  const checks = systemThemeChecks(
    f.routes.map((r) => r.bridge),
    interact,
    f.read,
  );
  await assert.rejects(
    checks[0].execute(new AbortController().signal),
    /0 из 2/,
  );
  assert.equal(
    (
      (await checks[1].execute(new AbortController().signal)) as {
        state: string;
      }
    ).state,
    "passed",
  );
});

test("skip or interruption releases theme listeners and never creates a successful result", async () => {
  const f = fixture();
  const checks = systemThemeChecks(
    f.routes.map((r) => r.bridge),
    async (request) => {
      await request.action!("");
      return { decision: "skip" };
    },
    f.read,
  );
  assert.equal(
    (
      (await checks[0].execute(new AbortController().signal)) as {
        state: string;
      }
    ).state,
    "manual",
  );
  for (const route of f.routes) assert.equal(route.listeners.size, 0);
  const stopped = systemThemeChecks(
    f.routes.map((r) => r.bridge),
    async (request) => {
      await request.action!("");
      throw new Error("Stopped");
    },
    f.read,
  );
  await assert.rejects(
    stopped[0].execute(new AbortController().signal),
    /Stopped/,
  );
  for (const route of f.routes) assert.equal(route.listeners.size, 0);
});
