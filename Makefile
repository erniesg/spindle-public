.PHONY: check contract-check

PYTHON ?= python3

# Shared behavior/API/package checks; native execution remains a separate gate.
check:
	npm run typecheck
	npm run build
	python3 -m unittest discover -s tests -v
	node --max-old-space-size=256 --test --test-concurrency=1 build/tests/*/*.test.js build/browser-extension/connection-probe/tests/host.test.js
	git diff --check

# Optional draft-schema tooling; use the task-local Python from contracts/draft/README.md.
contract-check:
	$(PYTHON) -m unittest discover -s tests/contracts -v
	$(PYTHON) tools/draft_capture_contract.py
