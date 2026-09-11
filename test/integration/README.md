# test/integration

Nothing here yet — this directory holds the Postgres-and-Redis-backed
integration suite, most importantly the reservation-concurrency and
saga-compensation tests that prove this project's two centerpiece
claims (`docs/ARCHITECTURE.md` §2 and §5–7).

**Full spec for every test that belongs here: see `../../docs/TESTING.md`.**
This file is just the pointer; that document is the source of truth for
what to build and why.

**Build order** (matching `docs/TESTING.md`'s numbering and
`docs/CURSOR_CONTEXT.md`'s build order):

1. `reservation-concurrency.spec.ts` (`docs/TESTING.md` §1) — **the
   single most important test in this repo.** Requires `make up`
   running.
2. `saga-compensation.spec.ts` (`docs/TESTING.md` §2).
3. `database-role-enforcement.spec.ts` (`docs/TESTING.md` §3) — connects
   directly with each role's own credentials, not through the
   application.
4. `saga-timeout-sweep.spec.ts` (`docs/TESTING.md` §4).
5. `outbox-read-model-sync.spec.ts` (`docs/TESTING.md` §5).
6. `price-snapshot.spec.ts` (`docs/TESTING.md` §6).
7. `vendor-scoped-writes.spec.ts` (`docs/TESTING.md` §7).
8. `end-to-end-flow.spec.ts` (`docs/TESTING.md` §8).
