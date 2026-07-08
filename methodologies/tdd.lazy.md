# TDD Methodology - Lazy Pack

Initialize this pack on first use.

## First-Use Prompt

Ask the owner:

```text
TDD profile is not initialized for this stack. Use the generic red-green-refactor
loop now, or search official/current testing conventions for {{STACK_NAME}} first?
```

## Generic TDD Loop

1. Red: write or update a failing test that expresses the behavior.
2. Green: implement the smallest change that passes.
3. Refactor: clean up while tests stay green.
4. Verify: run the stack's canonical test command.
5. Document: note test coverage and remaining gaps.

## Stack Adapter Needed

Fill after initialization:

```yaml
tdd:
  unit_test_command: "{{UNIT_TEST_COMMAND}}"
  integration_test_command: "{{INTEGRATION_TEST_COMMAND}}"
  e2e_test_command: "{{E2E_TEST_COMMAND | optional}}"
  test_file_conventions: "{{TEST_FILE_CONVENTIONS}}"
  mocking_policy: "{{MOCKING_POLICY}}"
```
