import { Text } from "@lo-ink/ui";
import { useEffect, useState } from "react";
import { version as appVersion } from "../package.json";
import sdkBuild from "../sdk-build.json";

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
      <Text tone="secondary" size="caption">
        LO SDK Test · {appVersion}
      </Text>
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
              <Text as="span" size="caption" className="sdk-package">
                <Text as="code" family="mono" size="caption">
                  {p.name}
                </Text>
                <Text as="span" size="caption" className="sdk-version-number">
                  {p.version}
                </Text>
              </Text>
              <Text
                as="span"
                size="caption"
                tone={state === "current" ? "success" : "secondary"}
                weight={
                  state === "update" || state === "ahead" ? "medium" : "regular"
                }
                className="version-status"
              >
                {loading ? "Проверяем…" : labels[state]}
              </Text>
            </li>
          );
        })}
      </ul>
      <Text
        tone="secondary"
        size="caption"
        className="sdk-comparison"
        role="status"
      >
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
      </Text>
    </details>
  );
}
