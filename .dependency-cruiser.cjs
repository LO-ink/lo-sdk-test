module.exports = {
  forbidden: [
    {
      name: "no-cycles",
      severity: "error",
      from: {},
      to: {
        circular: true,
      },
    },
    {
      name: "no-unresolved-imports",
      severity: "error",
      from: {},
      to: {
        couldNotResolve: true,
      },
    },
    {
      name: "production-does-not-import-tests",
      severity: "error",
      from: {
        path: "^(src|bin|actions|web|server|packages/[^/]+/src|apps/[^/]+/src)/",
      },
      to: {
        path: "(^|/)(test|tests|compatibility)/",
      },
    },
    {
      name: "browser-has-no-node-dependencies",
      severity: "error",
      from: {
        path: "^web/",
      },
      to: {
        dependencyTypes: ["core"],
      },
    },
    {
      name: "browser-does-not-import-server",
      severity: "error",
      from: {
        path: "^web/",
      },
      to: {
        path: "^server/",
      },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    exclude: "(^|/)(dist|node_modules|vendor)/",
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "types", "node", "default"],
    },
  },
};
