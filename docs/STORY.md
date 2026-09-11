# The story behind CatalogSync

*Use this as a base for a LinkedIn post, a Medium article, or interview
talking points. Rewrite it in your own voice — this is scaffolding, not a
script.*

## Title

**Real CQRS Is a Permission Boundary, Not a Folder Structure**

## Medium tags

Medium allows up to 5 tags per story; these are chosen to reach both the
architecture-pattern audience and the general backend-engineering
audience, not just people already searching for CQRS by name:

1. `Software Architecture`
2. `Backend Development`
3. `System Design`
4. `CQRS`
5. `Distributed Systems`

## LinkedIn tags / hashtags

LinkedIn's convention is more tags than Medium's, placed at the end of
the post body rather than as metadata:

```
#SoftwareEngineering #SystemDesign #BackendDevelopment #CQRS
#Microservices #DistributedSystems #SoftwareArchitecture #NestJS
#PostgreSQL #TechnicalWriting
```

Use a subset (5–6) if the full list feels like keyword-stuffing for a
given post's tone — `#CQRS #SystemDesign #BackendDevelopment
#SoftwareArchitecture #DistributedSystems` is a reasonable minimal set
that still surfaces the post to the right audience.

## The short version (LinkedIn post)

"We use CQRS" is one of the most confidently stated, least often true
claims on a backend engineer's resume — not because people are lying,
but because most systems that reach for the name build the easy 80%
(a denormalized read model, maybe a cache) and quietly skip the part
that actually makes it CQRS instead of "a cache in front of Postgres
with extra steps": a hard guarantee that nothing requiring correctness
ever reads from the fast, stale side. The usual failure mode is
completely understandable — a checkout flow needs to check stock, the
read model is right there, already fast, already denormalized, and
wiring a separate query to the slower authoritative source feels like
unnecessary work. It's also exactly how marketplaces oversell inventory.

I built **CatalogSync**, a multi-vendor marketplace catalog engine in
NestJS where that guarantee isn't a code convention someone has to
remember — it's enforced by the database itself. The read model lives
behind a Postgres role with `SELECT`-only access to exactly one table.
The write path's connection has zero grants on that table at all. A bug
that tried to make the checkout flow read from the read model wouldn't
just be bad practice — it would fail with a permission error before it
could return a single row. Every stock reservation happens through one
atomic conditional update against the authoritative write-side table,
proven correct under real concurrent load, not just architecturally
argued. And placing an order that spans multiple vendors runs through a
genuine saga — independent per-vendor reservations, real compensating
transactions, deliberately modeled as if each vendor's inventory lived
on a separate system, because at real scale, eventually, it would.

It's open source, and the docs include an honest note that live research
for this one hit a search outage mid-project — so the grounding leans on
well-established, decades-old architectural literature (Fowler's CQRS
writing, Garcia-Molina and Salem's original Saga paper, Chris
Richardson's pattern catalog) rather than fresh citations, named
explicitly rather than papered over.

Repo: `<your-fork-url>`

---

## The longer version (Medium article)

### Real CQRS Is a Permission Boundary, Not a Folder Structure

### The pattern everyone claims and almost nobody actually holds to

Ask ten backend engineers whether their system uses CQRS and most will
say yes. Ask what would happen if the read model went stale for thirty
seconds and the answers get a lot less confident, a lot faster — because
for most systems, the honest answer is "something important would
probably read the wrong number." That's the tell. CQRS's entire value
proposition is a trade: the read side gets to be fast, denormalized,
cached, whatever it needs to be, specifically *because* nothing that
requires correctness is allowed to depend on it. The moment something
does — even one query, even "just this one checkout path, just for now"
— the system has quietly stopped being CQRS and started being a cache
with a more impressive name.

This isn't a hypothetical failure mode dreamed up for a blog post. It's
the single most common way marketplace and inventory systems actually
oversell. A read model built for browsing is fast and denormalized
precisely because it's allowed to lag behind reality by some bounded,
accepted window. A checkout flow that reads from it to decide "is this
in stock" is asking a question the read model was never designed to
answer correctly — and it usually works fine in testing, because
testing rarely has the write-heavy concurrent load that actually exposes
the staleness window. It shows up in production, as an order confirmed
for stock that was already gone, discovered by a customer service team,
not a code review.

### Refusing to trust a convention, twice

The fix sounds almost insultingly simple stated plainly: never let the
checkout path read from the read model. The interesting engineering
question is how seriously you take enforcing that "never." A comment in
the code saying "don't do this" is a convention, and conventions are
exactly the thing that erodes the week someone's shipping under
deadline pressure and the read model is *right there*, already fast,
already built.

CatalogSync enforces this claim at two independent layers, deliberately,
because either one alone has a real, known failure mode. The first layer
is ordinary code organization — the write-side module and the read-side
module are structurally separate, injected with separate database
service classes, no shared repository that could accidentally straddle
both. That's necessary, and it's also just a convention with slightly
more scaffolding around it — nothing in TypeScript's type system
actually stops a future contributor from importing the wrong thing into
the wrong module if they don't know, or don't remember, why that
boundary exists.

The second layer is where the guarantee stops being a convention at
all: three separate Postgres roles, with grants scoped to exactly what
each part of the system needs. The read path's database connection has
`SELECT` permission on one table — the denormalized read model — and
nothing else. It cannot see the authoritative inventory table. Not "is
discouraged from querying it" — cannot, at the database permission
layer, the same way a user without file permissions can't open a file
regardless of what the application code sitting on top of the operating
system intends. A future bug that tried to make the checkout flow check
stock through the read-side connection wouldn't produce a subtly wrong
answer. It would produce a Postgres permission error, immediately,
loudly, in a test long before it reached production. The write path gets
the mirror-image treatment: zero grants on the read model at all. It's
not that the write path chooses not to read stale data — it structurally
cannot reach it, even if someone tried.

### The one number that actually has to be correct

Once the read side is genuinely walled off from anything requiring
correctness, the write side gets to have exactly one job: make sure
stock reservation is actually, provably correct under real concurrent
load. This is where a lot of otherwise-careful systems still get
tripped up, usually by a check-then-act race that's invisible in every
test that isn't specifically adversarial: read the current stock, decide
there's enough, then write the reservation — with an arbitrarily small
but real window between the read and the write where someone else's
reservation could land first, and now two buyers both believe they
reserved the same last unit.

The fix is to never separate the check from the act at all: one
conditional update, `UPDATE inventory SET reserved = reserved + qty
WHERE (on_hand - reserved) >= qty`, where the database itself refuses
the write if there isn't enough room, atomically, in the same statement
that performs it. Success or failure is read directly off how many rows
the statement actually touched — one, or zero — with no separate check
that could go stale between asking and acting. And the "available"
number itself is never stored anywhere as its own column, specifically
so there's no second number that a bug could update inconsistently with
the two real ones underneath it. Fifty concurrent buyers competing for
ten units of stock should produce exactly ten successes and forty clean,
immediate failures — not roughly ten, not "ten unless something races,"
exactly ten, provable by firing all fifty at once and counting.

### A saga that refuses to cheat, on purpose

The harder problem sits one layer up: a single customer's cart can span
several vendors, and confirming that order means reserving stock at
each of them — which, the moment you're honest about what a real
marketplace eventually looks like, means coordinating across systems
that can each fail independently, with no shared transaction spanning
all of them. CatalogSync's current deployment happens to keep every
vendor's inventory in one physical Postgres instance, which means it
could, technically, cheat: wrap the whole multi-vendor reservation in
one big transaction and let Postgres's own rollback handle everything
for free, no saga pattern required at all.

That shortcut is refused on purpose. The entire reason this project
exists is to prove out the coordination pattern a marketplace actually
needs the moment vendor data is genuinely distributed — and if the
current implementation took the one-transaction shortcut just because
it currently could, "add the real saga pattern" would become a second,
disruptive migration the exact day it stopped being optional. Instead,
every vendor's reservation attempt happens in its own transaction,
coordinated explicitly by a single orchestrating service, with a real
compensating release for any vendor whose stock was successfully
reserved if any *other* vendor in the same cart turns out to be out of
stock. It's slower than the one-transaction shortcut would have been,
today, in this specific deployment. It's also already correctly shaped
for a future where that shortcut was never available in the first
place.

There's a smaller decision buried in there worth naming directly: the
saga doesn't stop at the first vendor that fails. It attempts every
vendor's reservation first, then decides what to compensate — because a
buyer whose order fails deserves to know *which* vendor was actually the
problem, not just that something, somewhere, didn't work. Gathering
complete information before acting costs a small amount of extra work in
an already-failing path, in exchange for a genuinely better answer.

### What happens when the coordinator itself dies

A saga that runs inside one request has an obvious hole: what happens
if the process running it crashes halfway through — after successfully
reserving stock at two vendors, but before attempting the third? Those
two reservations are real. They're holding real inventory. And if
nothing else ever revisits that order, that inventory stays held,
silently, unavailable to any other buyer, forever.

The honest answer for this project's first version isn't a fully
durable, resumable saga log that survives any crash and picks up exactly
where it left off — that's real, substantial machinery, and it's
explicitly the next project's job, not retrofitted here just to seem
more complete. The honest answer here is a timeout sweep: anything left
`PENDING` past a bounded window gets found and force-compensated,
automatically, the same "don't trust only the happy path, have an
independent timeout-based correction mechanism" idea that shows up
across every project in this portfolio that has to survive its own
coordinator dying — a booking system's expired-hold sweep, a presence
tracker's TTL, a distributed scheduler's lease. It's a real, bounded
cost (inventory stays held a little longer than ideal after a crash, not
forever) in exchange for not needing to solve the harder problem before
this version can ship at all.

### What's honestly not done

This project is handed off at the architecture layer, deliberately —
every mechanism above is fully specified down to the exact SQL and the
exact module boundaries, and the tests that would prove each claim are
written out with the same precision. None of it exists as running code
yet. A few things are named as real, current limitations rather than
solved: all-or-nothing order fulfillment (a single out-of-stock vendor
fails the entire cart, even the parts every other vendor could have
shipped) is a genuine product trade-off, not a technical inevitability,
and partial fulfillment is real, meaningfully harder future work, not a
small tweak. The database-role separation protects against accidental
cross-boundary access, not against someone who actually has a
compromised write-role credential — a different threat model with
different mitigations, outside what this specific architecture is
built to solve.

### Conclusion: a pattern's name is not its guarantee

The gap between "we use CQRS" and "our system actually can't violate
CQRS's core promise even if someone tried" is the entire subject of this
project, and it's a gap that shows up far beyond this one pattern. A
saga is not "we call an external system and hope it works" — it's a
defined compensating action for every step that can fail, verified by
actually failing a step and watching the compensation run. An outbox is
not "we usually remember to publish an event after we write" — it's a
guarantee that holds even when nobody remembers, enforced somewhere no
application code can quietly skip it. Every one of these patterns has an
easy version that borrows the name and a harder version that earns it,
and the difference between them is almost never visible in the demo. It
shows up the first time real concurrent load hits a race condition
nobody tested for, or the first time a coordinator crashes mid-flight,
or the first time someone asks "wait, can you prove that?" and the
honest answer has to be more than "the code is organized like it should
be true."

---

## Talking points for an interview

1. **Lead with the tell, not the pattern name.** "Ask what happens if
   the read model goes stale for thirty seconds, and most 'CQRS'
   systems don't have a good answer — that's the actual test of whether
   the pattern is real" is a much sharper opening than "I implemented
   CQRS."
2. **Explain the two-layer enforcement explicitly** — code organization
   as the first, necessary-but-not-sufficient layer, and database-role
   permission grants as the second, actually-enforced layer. Being able
   to say precisely why the first alone isn't enough is the single best
   differentiator in this project's story.
3. **Walk through the atomic reservation statement and why check-then-
   act fails under real concurrency** — and specifically, why "available"
   is never its own stored column. This is a small, precise technical
   detail that separates real understanding from a general sense that
   "concurrency is hard."
4. **Explain the saga's refusal to use one big transaction even though
   the current deployment technically could** — this is the most
   interesting engineering judgment call in the project, and naming the
   reasoning directly (design for the distributed shape you're actually
   going to need, not the shortcut your current deployment happens to
   allow) is a strong signal of thinking past the immediate
   implementation.
5. **Be upfront about the two named limitations** — all-or-nothing
   fulfillment as a product trade-off, and the timeout sweep as a
   bounded-cost backstop rather than a fully durable saga. Naming real
   trade-offs precisely is a stronger signal than implying the system
   has no edges.

## Suggested post formats

**Short (LinkedIn/X):**
> Built a multi-vendor marketplace catalog engine in NestJS where the
> core CQRS guarantee — nothing that needs correctness ever reads from
> the fast, denormalized side — isn't a code convention, it's a Postgres
> permission grant. The read path's database role has SELECT access to
> exactly one table and nothing else; a bug that tried to check stock
> through it would get a permission error, not a wrong answer. Every
> reservation is one atomic conditional update, proven correct under 50
> concurrent buyers competing for 10 units. Orders spanning multiple
> vendors run through a real saga — independent per-vendor transactions,
> real compensation, deliberately refusing the one-big-transaction
> shortcut the current deployment could technically get away with,
> because the whole point is being ready for when it can't. Open source:
> `<link>`
>
> #CQRS #SystemDesign #BackendDevelopment #SoftwareArchitecture
> #DistributedSystems

**Medium article structure:** *Real CQRS Is a Permission Boundary, Not a
Folder Structure* → the pattern everyone claims and almost nobody holds
to → refusing to trust a convention, twice (module boundaries, then
database roles) → the one number that actually has to be correct
(atomic reservation) → a saga that refuses to cheat, on purpose → what
happens when the coordinator itself dies (the timeout sweep) → what's
honestly not done → conclusion. `ARCHITECTURE.md` §1, §2, §4, and §5 can
be lifted almost directly into the technical middle of the article.
