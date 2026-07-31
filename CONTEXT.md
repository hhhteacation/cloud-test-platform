# Domain Glossary

## Artifact

An immutable input or output content item used or produced by a test. Its content identity is established by a cryptographic hash.

## Test Plan

An immutable, versioned collection of input constraints, platform protocol, checks, timeouts, and conclusion rules.

## Test Campaign

A cross-platform SDK validation objective containing one or more platform-specific Tasks.

## Task

A platform-specific test intent combining an application Artifact, a media Artifact, one Test Plan, and a target Device Set.

## Device Run

The logical target created when one Task is assigned to one Device.

## Attempt

One physical execution try for a Device Run. A retry always creates a new Attempt and never overwrites a previous one.

## Device Snapshot

The immutable description of a Device and its relevant environment captured for an Attempt.

## Platform Protocol

A versioned contract describing how a target platform installs a test application, supplies input, starts work, observes completion, collects output, cancels, and cleans up.

## Check

One independently explainable assertion evaluated under a versioned rule and severity.

## Evidence

A file or structured record that supports a Check or Conclusion.

## Conclusion

A business judgment calculated from versioned rules and completed Checks. A Conclusion is distinct from lifecycle status.

## Runner

A managed execution node located with or near the Devices it controls. It receives structured Attempts from the Control Plane and performs them through platform-specific Adapters.

## Device Lease

A time-bounded exclusive right for one Attempt to use one Device.

## Fencing Token

A monotonically ordered token attached to a Device Lease. A result carrying an older token cannot replace state or Evidence from a newer Lease.

## Ready Device

A Device that is online and has passed all readiness requirements of the selected Platform Protocol and Test Plan. Online alone does not mean ready.

## Physical Device

One real phone or tablet. A Physical Device has one Device identity even when its Runner can reach it through multiple connection endpoints.

## Device Connection

One connection endpoint from a Runner to a Physical Device, such as USB/data cable or a controlled network endpoint. Every production Device must retain a verified wired data-cable connection. Devices in the committed acceptance matrix must also support a controlled network endpoint and complete the same compatibility Test Plan through both connection types.

## Connection Policy

The connection requirement of a Device Run: `wired_only`, `network_only`, `prefer_wired`, or `network_allowed`. Phase acceptance runs the same complete Test Plan separately with `wired_only` and `network_only` for every device in the committed device matrix.

## Actual Connection

The Device Connection selected for an Attempt. It is recorded in the Execution Manifest and cannot change silently during that Attempt.

## Control Plane

The authoritative module that accepts user intent, schedules Attempts, grants Device Leases, stores status, evaluates Conclusions, and exposes reports. It does not expose raw device-control ports to users.

## Adapter

A trusted platform or infrastructure implementation registered at a stable seam, such as Android ADB, iOS XCTest, Harmony HDC, an Artifact Store, or an Event Delivery implementation.


## Test Mode

The business style of a Test Plan, initially `compatibility`, `stability`, or `robustness`. Test Mode changes workload and outcome rules but does not create a separate scheduling or task system.

## Scenario Run

One business scenario executed inside an Attempt, such as a compatibility feature matrix, a long-running stability session, or a robustness mutation matrix.

## Case Execution

One concrete input, iteration, feature combination, or fault variant inside a Scenario Run. It records expected and observed outcomes, metrics, and Evidence independently.

## Input Variant

An immutable normal or mutated input used by one Case Execution. A mutated variant records its base Artifact, recipe version, and random seed so it can be reproduced.

## Expected Outcome

The versioned behavior expected from a Case Execution, including success, an expected failure code, an expected fallback, an expected degraded behavior, and whether the process must not crash.

## Outcome Oracle

A versioned rule component that compares an Expected Outcome with the Observed Outcome and produces an explainable Case conclusion.

## Metric Sample

One timestamped resource or performance observation. High-frequency Metric Samples are bounded and summarized; they are not written without limit into the core transactional database.

## Stability Session

A long-running Scenario Run defined by duration or iteration count, datasets, lifecycle actions, observation policies, and stability thresholds.

## Robustness Recipe

A versioned and reproducible mutation or fault-injection definition used to create abnormal Input Variants without changing the immutable base Artifact.

## SDK Scenario Adapter

A trusted implementation that prepares and invokes a specific SDK business flow and parses its business results. It is separate from the Platform Adapter, which controls the device and operating-system tooling.

## Release Policy

A versioned set of platform coverage, required Checks, thresholds, and exemption rules used to calculate whether a software release is blocked, warned, or allowed.
