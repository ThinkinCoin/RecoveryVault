// .solcover.js
module.exports = {
  mocha: {
    require: [
      "ts-node/register/transpile-only",
      "tsconfig-paths/register",
      "@nomicfoundation/hardhat-chai-matchers" // side-effect import
    ],
    timeout: 180000
  },
  istanbulReporter: ["text", "html", "lcov"],
  skipFiles: [
    "hub/",        // se você está apontando para OZ via submódulo/pasta "hub"
    "mocks/"       // se quiser ignorar mocks na métrica
  ],
};
