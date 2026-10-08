import assert from "node:assert/strict";
import test from "node:test";
import {
  createRunPersistence,
  persistenceUnavailable,
} from "../web/persistence.ts";

for (const failure of ["getter", "read", "write", "remove"] as const) {
  test(`storage ${failure} denial stays closed and never pretends memory is durable`, () => {
    let rejected = failure === "getter" || failure === "read";
    let notifications = 0;
    const values = new Map([["existing", "cleanup debt"]]);
    const store = {
      getItem: (key: string) => {
        if (rejected && failure === "read")
          throw new Error("private read error");
        return values.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        if (rejected) throw new Error("private quota error");
        values.set(key, value);
      },
      removeItem: (key: string) => {
        if (rejected) throw new Error("private storage error");
        values.delete(key);
      },
    } as Storage;
    const boundary = createRunPersistence(() => {
      if (rejected && failure === "getter")
        throw new DOMException("private origin", "SecurityError");
      return store;
    });
    const release = boundary.subscribe(() => {
      notifications++;
    });
    if (failure === "write" || failure === "remove") {
      assert.equal(boundary.storage.getItem("existing"), "cleanup debt");
      rejected = true;
      assert.throws(
        () =>
          failure === "write"
            ? boundary.storage.setItem("existing", "cleared")
            : boundary.storage.removeItem("existing"),
        { message: persistenceUnavailable },
      );
    }
    assert.equal(boundary.unavailable, true);
    assert.equal(notifications, 1);
    assert.equal(values.get("existing"), "cleanup debt");
    rejected = false;
    assert.throws(() => boundary.storage.setItem("existing", "cleared"), {
      message: persistenceUnavailable,
    });
    assert.throws(() => boundary.storage.getItem("existing"), {
      message: persistenceUnavailable,
    });
    release();
    assert.equal(values.get("existing"), "cleanup debt");
  });
}
