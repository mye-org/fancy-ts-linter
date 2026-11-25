# `fancy-ts-linter`

A type-aware TypeScript static analyzer and AI-agent hint engine built for automated coding loops. It enforces a strict **Canonical Single-`flow` Module** style (`fp-ts` + `monocle-ts` + `newtype-ts` + `ts-pattern`) and emits structured refactoring hints for Domain-Driven Design (DDD), Monads, Optics, and declarative programming.

---

## Core Design Principles

- **One Exported Function per Module:** Every file exposes `export const <domainName> = flow(...) satisfies <FnType>` as its sole runtime export (`export type` is allowed).
- **Point-Free & Unary:** All functions have arity `1` (curried unary factories allowed), expression bodies only, zero inline lambdas, zero `pipe(...)`, and no nested `flow(...)`.
- **Mandatory `satisfies` on Export, Inference Inside:** The exported `flow` must pin its contract with `satisfies`; private helpers prefer type inference.
- **Illegal States Unrepresentable:** Prefer `newtype-ts` branded types over raw primitives and Discriminated Union ADTs + `ts-pattern` structural matching over boolean flags.
- **Two-Tier Feedback for AI Loops:**
  - **Tier 1 Hard Errors (`exit 1`):** Must be fixed before the loop passes.
  - **Tier 2 Advisory Hints (`exit 0`):** Architectural, DDD, and declarative upgrades + a full Module Type-Flow Map.

---

## Quick Start

### Installation & Build

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test
```

### CLI Usage

```bash
node bin/fancy-ts-linter.mjs <file...> [options]
```

| Flag | Default | Description |
| :--- | :--- | :--- |
| `--tsconfig <path>` | Auto-discovered | Path to `tsconfig.json` for full type resolution |
| `--format <json\|md>` | `json` | `json` (machine-readable `AnalysisReport`) or `md` (token-efficient LLM report) |
| `--max-flow-steps <n>` | `10` | Step-count threshold before emitting a `ddd-decomposition` hint |
| `--help` | `false` | Show CLI usage |

| Exit Code | Meaning |
| :---: | :--- |
| `0` | Zero Tier 1 hard errors (may still include Tier 2 advisory hints) |
| `1` | One or more Tier 1 hard errors found |
| `2` | Invalid CLI arguments or target file failed to load |

---

## Canonical Module Anatomy

```ts
import { flow } from 'fp-ts/function';
import * as E from 'fp-ts/Either';
import { Newtype, iso } from 'newtype-ts';
import { match, P } from 'ts-pattern';

export type USD = Newtype<{ readonly USD: unique symbol }, number>;
export type Order =
  | { readonly _tag: 'Draft'; readonly subtotal: USD }
  | { readonly _tag: 'Confirmed'; readonly subtotal: number };
export type PriceOrder = (order: Order) => E.Either<string, number>;

const isoUSD = iso<USD>();
const isPositive = (n: number) => n > 0;
const nonPositive = (_: number) => 'Non-positive subtotal';

const validateDraft = flow(
  isoUSD.unwrap,
  E.fromPredicate(isPositive, nonPositive),
);

const normalize = (order: Order) =>
  match(order)
    .with({ _tag: 'Draft', subtotal: P.select() }, validateDraft)
    .with({ _tag: 'Confirmed', subtotal: P.select() }, E.right)
    .exhaustive();

const roundCents = (n: number) => Math.round(n * 100) / 100;

export const priceOrder = flow(
  normalize,
  E.map(roundCents),
) satisfies PriceOrder;
```

---

## Tier 1: Hard-Error Rules (`exit 1`)

| Rule ID | Category | Enforced Invariant |
| :--- | :--- | :--- |
| `TS*` | `tsc` | Zero TypeScript compiler syntactic/semantic diagnostics |
| `no-type-holes` | `type-safety` | Forbids `any`, `as` casts (except `as const`), `<T>x`, and `!` non-null assertions (`satisfies` allowed) |
| `single-exported-flow` | `structure` | Exactly 1 runtime export, which must be `export const <name> = flow(...)` |
| `export-requires-satisfies` | `export-satisfies` | Exported `flow` must use `satisfies <Type>` |
| `no-disallowed-top-level` | `structure` | Only imports, types, private functions, Optics, ADT matchers, and `fp-ts` typeclass instances |
| `no-pipe` | `point-free` | Forbids `pipe(...)` everywhere |
| `no-nested-flow` | `point-free` | Forbids `flow(...)` nested inside another `flow(...)` |
| `no-trivial-flow` | `point-free` | Forbids 0-step or 1-step `flow(f)` |
| `unary-arity-only` | `point-free` | All functions must have arity 1 (use a named Input/Domain Record, or at most 2–3 curried levels when partially applied) |
| `max-curry-depth` | `point-free` | Forbids curried chains deeper than 3 levels (`a => b => c => d => ...`); collapse into an input record or 2-level `(ctx) => (input)` |
| `no-inline-lambda` | `point-free` | Forbids anonymous lambdas inside `flow(...)` or combinator arguments |
| `no-eta-reducible` | `point-free` | Forbids `x => f(x)` wrappers |
| `no-block-body` | `declarative-purity` | Forbids `{ ... }` block bodies on functions |
| `no-imperative-constructs` | `declarative-purity` | Forbids `let`/`var`, `if`, `switch`, `for`, `while`, `try`/`catch`, `throw`, `async`/`await`, `=`, `++`/`--` |
| `no-mutating-methods` | `declarative-purity` | Forbids `.push`, `.pop`, `.splice`, `.sort`, `.reverse`, `.forEach`, `Object.assign` |
| `no-ternary` | `branching` | Forbids `? :` ternary expressions |
| `no-nullish-operators` | `branching` | Forbids `?.` and `??` |
| `ts-pattern-exhaustive` | `branching` | Requires `ts-pattern` `match(...)` chains to end in `.exhaustive()` |
| `no-nullable-types` | `monad` | Forbids `null`/`undefined` in signatures and domain fields (`O.fromNullable` boundary lifts allowed) |
| `no-raw-promise` | `monad` | Forbids raw `Promise<T>` in signatures (`Task`/`TaskEither` and `TE.tryCatch` lifts allowed) |
| `no-nested-spread` | `optic` | Forbids nested object spreads (`{ ...a, b: { ...a.b, c } }`); use `monocle-ts` Optics |

---

## Tier 2: Advisory AI Hints (`exit 0`)

| Hint Category | Static Signal | Guidance Provided |
| :--- | :--- | :--- |
| `adt-over-flags` | Multi-boolean structs, boolean+optional pairs, `status: string`, boolean params | Suggests Discriminated Union ADTs + `ts-pattern` |
| `newtype-brand` | Raw `string`/`number` domain fields in exported types | Suggests `newtype-ts` `Newtype<...>` + `iso`/`prism` |
| `pattern-matching-depth` | Shallow 1-level `match` whose handlers branch again | Suggests `P.when`, `P.select`, `P.union`, and tuple matrix matching |
| `ddd-decomposition` | `flow` exceeding `--max-flow-steps`, or mixed pure + I/O steps | Suggests named sub-flows and pure `Either` core / `TaskEither` shell split |
| `arity-strategy` | Multi-parameter functions or curried chains of 3+ levels | Advises **Input/Domain Record** (`(input: FnInput) => ...`) by default, or **at most 2–3 curried levels** only when outer args are partially applied |
| `monad` | Threaded config/deps across helpers or `Array<Effect<T>>` | Suggests `Reader`/`ReaderTaskEither` or `RA.traverse` |
| `optic` | Repeated nested property chains or spread + array `.map` | Suggests `Lens.fromPath` or `Traversal` |
| `declarative-combinator` | Self-recursion or manual `reduce` | Suggests `RA.filterMap`, `RA.partitionMap`, `Monoid.concatAll` |
| `inference-hygiene` | Unexported bindings with redundant return types/`satisfies` | Suggests omitting redundant annotations when TS infers the same type |

---

## Project Structure

| Path | Purpose |
| :--- | :--- |
| `src/index.ts` | Public library API (`analyzeFiles`) |
| `src/cli.ts` & `bin/fancy-ts-linter.mjs` | CLI argument parsing and exit-code handling |
| `src/compiler/` | `tsconfig.json` loader, `tsc` diagnostics, TypeChecker predicates |
| `src/ir/moduleGraph.ts` | Module IR and `TypeFlowGraph` extractor |
| `src/rules/` | Tier 1 hard-error rule implementations |
| `src/hints/` | Tier 2 AI hint detectors |
| `src/reporters/` | JSON and Markdown output formatters |
| `test/fixtures/canonical/` | Golden canonical FP modules (0 Tier 1 errors) |
| `test/fixtures/violations/` | Imperative & hint-triggering test fixtures |
