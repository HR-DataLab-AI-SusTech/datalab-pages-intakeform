# One gate command. `make check` runs .github/workflows/ci.yml itself through ci-local (needs Docker),
# so ci.yml stays the single definition of the gate. `make test` is the fast native loop: lint and the
# bridge syntax parse only, no Docker.
INFRA ?= ../infrastructure

.PHONY: check test

check:
	$(INFRA)/ci-local/run.sh .

test:
	npm run lint
	@set -eu; files=$$(find bridge -maxdepth 1 \( -name '*.js' -o -name '*.mjs' \)); \
	[ -n "$$files" ] || { echo "no bridge sources found"; exit 1; }; \
	for f in $$files; do node --check "$$f" && echo "  ok  $$f"; done
