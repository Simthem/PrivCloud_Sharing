export type UnitTestCase = {
  name: string;
  run: () => Promise<void> | void;
};

export function createUnitTestRunner(label: string) {
  const cases: UnitTestCase[] = [];

  const testCase = (name: string, run: UnitTestCase["run"]) => {
    cases.push({ name, run });
  };

  const run = async () => {
    for (const test of cases) {
      await test.run();
      console.log(`ok - ${test.name}`);
    }
    console.log(`${cases.length} ${label} tests passed`);
  };

  return { testCase, run };
}
