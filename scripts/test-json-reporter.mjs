import assert from "node:assert/strict";
import { JsonReporter } from "vitest/node";

const errorText = error => {
  const message = typeof error.message === "string" ? error.message : "";
  const stack = typeof error.stack === "string" ? error.stack : "";
  return message && stack && !stack.includes(message) ? `${message}\n${stack}` : stack || message;
};

/** Vitest can keep a collection stack while putting the real timeout in
 * error.message. Preserve both in the private report; test-evidence remains
 * the only CI diagnostic export. The built-in reporter owns all counters. */
export default class TestJsonReporter extends JsonReporter {
  #errors = [];
  constructor(options) {
    assert.ok(typeof options?.outputFile === "string" && options.outputFile.length > 0, "private JSON output path required");
    super(options);
  }
  async onTestRunEnd(modules) {
    this.#errors = modules.map(module => ({
      tests: [...module.children.allTests()].map(test => (test.result().errors ?? []).map(errorText)),
      suite: [...module.errors(), ...[...module.children.allSuites()].flatMap(suite => suite.errors())].map(errorText).join("\n"),
    }));
    try { await super.onTestRunEnd(modules); }
    finally { this.#errors = []; }
  }
  async writeReport(report) {
    const result = JSON.parse(report);
    assert.equal(result.testResults.length, this.#errors.length, "JSON reporter module count changed");
    // Change only the newly serialized document, never Vitest tasks or errors.
    result.testResults = result.testResults.map((file, index) => {
      const errors = this.#errors[index];
      assert.equal(file.assertionResults.length, errors.tests.length, "JSON reporter test count changed");
      return { ...file, message: errors.suite || file.message,
        assertionResults: file.assertionResults.map((test, testIndex) => ({ ...test, failureMessages: errors.tests[testIndex] })) };
    });
    await super.writeReport(JSON.stringify(result));
  }
}
