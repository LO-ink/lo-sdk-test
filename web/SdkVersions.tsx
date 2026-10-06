import { useEffect, useState } from "react";
import { version as appVersion } from "../package.json";
import sdkBuild from "../public/sdk-build.json";

type VersionState = "current" | "update" | "ahead" | "unknown";
type VersionCheck = {
  basis: string;
  checkedAt: string;
  packages: {
    name: string;
    version: string;
    sourceCommit: string;
    state: VersionState;
  }[];
};
const labels = {
  current: "Актуальна",
  update: "Есть обновление",
  ahead: "Новее main",
  unknown: "Не проверена",
};

export function SdkVersions() {
  const [check, setCheck] = useState<VersionCheck | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/sdk-versions", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Unavailable");
        const value = (await response.json()) as VersionCheck;
        if (
          value.basis !== "github-main" ||
          !Array.isArray(value.packages) ||
          !Number.isFinite(Date.parse(value.checkedAt))
        )
          throw new Error("Invalid metadata");
        if (!controller.signal.aborted) setCheck(value);
      })
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);
  return (
    <details className="sdk-versions" open>
      <summary>
        Версии SDK
        <svg
          className="disclosure-chevron"
          viewBox="0 0 16 16"
          width="16"
          height="16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="m4 6 4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </summary>
      <p className="note">LO SDK Test · {appVersion}</p>
      <ul>
        {sdkBuild.packages.map((p) => {
          const result = check?.packages.find(
            (item) =>
              item.name === p.name &&
              item.version === p.version &&
              item.sourceCommit === p.sourceCommit,
          );
          const state =
            result && Object.hasOwn(labels, result.state)
              ? result.state
              : "unknown";
          return (
            <li key={p.name}>
              <span className="sdk-package">
                <code>{p.name}</code>
                <span className="sdk-version-number">{p.version}</span>
              </span>
              <span className={`version-status ${state}`}>
                {loading ? "Проверяем…" : labels[state]}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="note sdk-comparison" role="status">
        {loading ? (
          "Проверяем обновления…"
        ) : check ? (
          <>
            Сравнение с main на GitHub ·{" "}
            {new Date(check.checkedAt).toLocaleString("ru-RU", {
              day: "2-digit",
              month: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </>
        ) : (
          "GitHub недоступен. Актуальность не проверена."
        )}
      </p>
    </details>
  );
}
