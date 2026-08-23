---
name: production-incident-response
description: "Use this skill to investigate and coordinate production incidents across services, infrastructure, and customer-facing dependencies. It preserves evidence, establishes a timeline, tests competing hypotheses, limits risky actions, and produces concise stakeholder updates. Trigger it for alerts, unexplained error-rate or latency changes, partial outages, cascading failures, failed deploys, or retrospective analysis even when the decisive request appears later: investigate a real production incident and prepare a safe recovery plan."
compatibility: Requires access to retained production telemetry and an incident timeline; never mutates production without explicit approval.
allowed-tools: read bash
metadata:
  workflow: incident-response
  safety: approval-required
---
# Production incident response

Use this workflow when a production system is degraded, unavailable, or behaving in a way that may harm customers. Optimize for safe diagnosis and recovery, not for producing a clever explanation quickly.

## Operating principles

1. Protect customers and preserve evidence before changing the system.
2. Separate observations from hypotheses. Label every unverified explanation.
3. Prefer reversible mitigations over irreversible repairs during an active incident.
4. Use the narrowest query that can answer the current question.
5. Record timestamps in UTC and include the observation source.
6. Never expose tokens, credentials, customer payloads, or private identifiers.
7. Do not deploy, restart, scale, roll back, or mutate remote state without explicit approval.
8. If telemetry disagrees, report the disagreement instead of averaging it away.

## Inputs to collect

Ask only for information that is missing and necessary:

- incident start time or the earliest known symptom;
- affected service, region, tenant class, endpoint, or user journey;
- current customer impact and whether it is growing;
- recent deploys, configuration changes, migrations, or dependency events;
- dashboards, alerts, logs, traces, and change records already available;
- the incident commander and communication channel, if one exists;
- actions already attempted and their observed outcomes.

Do not block initial triage while waiting for every input. State assumptions and begin with the strongest available signal.

## Phase 1: establish the incident frame

Create a compact incident frame before deep investigation:

```text
Status: investigating | mitigated | resolved
Start: <UTC timestamp or bounded estimate>
Impact: <who or what is affected>
Scope: <service, region, operation, tenant class>
Primary symptom: <measured behavior>
Recent change: <known change or none found>
Owner: <person or team if known>
Next checkpoint: <UTC timestamp>
```

Distinguish the first detected alert from the likely beginning of customer impact. If the start time is uncertain, use a range and explain how it was derived.

## Phase 2: verify impact and blast radius

Start from customer-visible signals, then move inward:

1. Confirm the symptom with at least one direct service-level signal.
2. Compare affected and unaffected dimensions: region, version, route, tenant, dependency, or instance pool.
3. Measure error rate, latency, saturation, and request volume over the same interval.
4. Check whether retries, queues, circuit breakers, or fallbacks are hiding part of the impact.
5. Identify correlated services without assuming correlation proves causation.

Use a comparison window that includes normal behavior before the incident. Avoid a window so large that the failure disappears in aggregation.

### Blast-radius table

```text
Dimension       Affected                    Unaffected / unknown
Service         <value>                     <value>
Region          <value>                     <value>
Version         <value>                     <value>
Operation       <value>                     <value>
Tenant class    <value>                     <value>
Dependency      <value>                     <value>
```

If every dimension appears affected, verify telemetry ingestion before concluding the whole platform failed.

## Phase 3: build a timeline

Record meaningful events in timestamp order:

```text
UTC time | Observation or action | Source | Confidence | Result
```

Include alerts, deploys, configuration changes, traffic shifts, dependency incidents, mitigation attempts, and recoveries. Keep raw evidence links or query references beside the timeline rather than relying on memory.

A useful timeline explains sequence without claiming causality. Write “error rate rose two minutes after deploy” until evidence supports “deploy caused error rate to rise.”

## Phase 4: generate and test hypotheses

Maintain a short ranked list. Each hypothesis needs supporting evidence, conflicting evidence, and one cheap discriminating test.

```text
Hypothesis: <specific mechanism>
Supports: <observations>
Conflicts: <observations>
Test: <safe query or comparison>
Expected if true: <result>
Expected if false: <result>
Status: open | weakened | confirmed | rejected
```

Prefer hypotheses that explain all major symptoms with the fewest assumptions, but keep alternatives when evidence is incomplete. Do not create a new hypothesis for every log line.

### Common hypothesis classes

- application regression or incompatible deploy;
- malformed or unexpected traffic shape;
- exhausted CPU, memory, connections, file descriptors, or worker pools;
- database lock, slow query, replication lag, or connection exhaustion;
- cache stampede, low hit rate, or invalidation failure;
- queue backlog, poison message, or consumer imbalance;
- DNS, certificate, routing, load balancer, or service discovery failure;
- dependency latency, throttling, quota, or regional outage;
- telemetry loss that makes a healthy system look unhealthy, or the reverse.

Treat this list as prompts, not conclusions.

## Phase 5: inspect metrics, logs, and traces

### Metrics

Use metrics to locate when and where behavior changed. Query a narrow set of dimensions first, then drill down. Check numerator and denominator when interpreting rates. A falling error count during a traffic collapse is not necessarily recovery.

Record the query, interval, aggregation, and important filters. Compare current values with a known-good period and with unaffected cohorts.

### Logs

Sample logs around transition points, not only at peak failure. Group repeated messages before reading individual examples. Correlate by request, trace, deployment, instance, or tenant identifier while redacting sensitive fields.

Do not equate the loudest log message with the root cause. Warnings often increase because another component has already failed.

### Traces

Use traces to identify where latency or errors enter the request path. Compare successful and failed traces for the same operation. Inspect parent-child timing, retries, fan-out, and status propagation.

A missing span may indicate instrumentation loss rather than zero work. Cross-check with service metrics and logs.

## Phase 6: choose a mitigation

Rank mitigations by expected impact, reversibility, time to apply, and risk:

```text
Mitigation | Expected benefit | Risk | Reversible | Approval needed | Verification
```

Examples include disabling a feature flag, shifting traffic, reducing concurrency, pausing a worker, rolling back a known change, or isolating a failing dependency. These are examples only; never execute them without explicit authorization.

Before proposing a mitigation:

- state the hypothesis it addresses;
- define the expected signal change;
- define a stop condition and rollback path;
- identify secondary impact;
- choose a verification window long enough to avoid a false recovery.

After an approved action, compare the same signals used to prove impact. Record exact start and completion times.

## Phase 7: communicate

Stakeholder updates should be factual, brief, and time-bounded. Use `templates/status-update.md` when available.

Every update should include:

- current customer impact;
- scope and trend;
- what is known and unknown;
- mitigation state;
- the next action;
- the next update time.

Avoid internal speculation in broad updates. Do not say “resolved” until customer-facing indicators are stable for the agreed verification window.

## Phase 8: close and hand off

Before declaring resolution:

1. Verify service-level signals returned to an acceptable range.
2. Confirm traffic and workload are representative, not temporarily absent.
3. Check queues, retries, replication, and delayed work for residual impact.
4. Ensure temporary mitigations have owners and expiration plans.
5. Preserve the timeline, queries, decisions, and follow-up tasks.
6. Schedule retrospective work when the incident meets local criteria.

Produce a final handoff with:

```text
Summary:
Customer impact:
Start / mitigation / recovery times:
Trigger or root cause status:
Mitigation performed:
Evidence of recovery:
Residual risks:
Follow-up owners:
```

## Retrospective mode

For a historical incident, do not pretend live telemetry is still available. Reconstruct the timeline from retained evidence, distinguish facts from recollections, and state retention gaps. Evaluate contributing conditions, detection quality, response quality, and why safeguards did or did not contain the issue.

Avoid reducing the analysis to a single human mistake. Prefer system changes that make the same class of failure easier to prevent, detect, contain, or recover from.

## Output quality checklist

Before answering, verify that the response:

- states impact and scope before implementation details;
- uses UTC timestamps or clearly labels another timezone;
- separates observations, hypotheses, actions, and outcomes;
- includes evidence for important conclusions;
- marks uncertainty and telemetry gaps;
- proposes only reversible or explicitly approved actions;
- contains no secrets or sensitive customer data;
- gives a concrete next step and checkpoint;
- preserves relative-path instructions using the returned base directory.
