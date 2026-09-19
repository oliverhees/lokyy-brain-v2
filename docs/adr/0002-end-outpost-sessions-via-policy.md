# ADR 0002 — End forward-auth (outpost) sessions through a fixed blueprint policy

- Status: accepted (lead decision (a) with view_policy + add_policy; re-audit pending)
- Date: 2026-09-19
- Work item: LBV2-27 (QA finding "disabled user keeps vault session", High)
- Decision by: lead (LBV2-27), to be confirmed by Oliver

## Context

Vault web access runs through Authentik's embedded proxy outpost (forward auth). The outpost keeps its own session per browser in Authentik's database (`ProxySession`, valid for the provider's token validity, 8 h). When the portal disables, removes or re-roles a person, authentik-gate deletes the person's Authentik sessions. Authentik then sends the outpost a session-end event (`outpost_session_end`, fire-and-forget over the channel layer). While the outpost reloads its providers, that event is lost: the `ProxySession` row stays and the old browser session keeps working, including vault writes and the company LLM. Reproduced on the QA stack: with provider saves once per second, a disabled user's vault answered 200 for at least 20 s, and the row never went away.

Authentik 2026.8.2 has no API to list or delete proxy sessions (`ProxySession` is internally managed; not in the REST API, not in blueprints).

## Decision

1. The Coolify blueprint (`deploy/coolify/generate.ts`) ships a fixed expression policy `lokyy-end-proxy-sessions`. It is bound to nothing. For its target user it deletes exactly that user's `ProxySession` rows (`session_data.claims.sub == user.uid`) and returns `True`. For superusers, members of `lokyy-admins` / `authentik Admins`, and accounts without `path == "lokyy"` and `lokyy_managed` it deletes nothing and returns `False`.
2. authentik-gate runs it through the policy test API (`POST /api/v3/policies/all/<pk>/test/`, `user = <target pk>`). It does this after deleting the Authentik sessions, in `DELETE /v1/users/<pk>/sessions`, and only for targets its own policy allows. If the policy is missing, returns `False` or fails, the gate answers 502. The portal then reports an error, never success.
3. The portal ends sessions on disable, on remove and on role change.
4. The portal's service-account role gets the global permissions `authentik_policies.view_policy` and `authentik_policies.add_policy`, and no other policy permission. The test API needs both, see below.

## Why these two permissions, globally

The test endpoint is a POST detail action on `/api/v3/policies/all/`. Authentik 2026.8.2 checks it in two steps:

- The action decorator requires `view_policy`, either globally or on the object.
- `ObjectPermissions` (Authentik's DRF permission class) maps POST to `add_<model>`, so `add_policy` on the base `Policy` model. Only the global permission avoids a crash. Without it, Authentik falls back to a per-object check, and for a subclass object (`ExpressionPolicy`) that check fails with `WrongAppError`: the permission's app label is `authentik_policies`, the object's is `authentik_policies_expression`. The result is HTTP 500.

An object permission on exactly this policy therefore does not work on this version, whether as `view_policy` or as `view_expressionpolicy`. The latter only lets the account list the policy.

`add_policy` on the base model creates nothing: `/policies/all/` has no create action, and the endpoints of the policy types check their own `add_<type>policy` permissions. Probe on a smoke stack with the portal service-account token and both permissions:

| Call | Result |
|------|--------|
| test `lokyy-end-proxy-sessions` | 200 (`passing: false` for an unmanaged user) |
| create an expression policy | 403 |
| patch the purge policy | 403 |
| create a policy binding | 403 |
| clear the policy cache | 403 |
| delete the purge policy | 500 (the same crash); the policy still exists |

With these permissions, the service account (token held only by authentik-gate) can read every policy and evaluate any policy for users it can view. Side effects are limited to this one policy. The policy refuses privileged and unmanaged accounts, and the gate refuses them before calling it. The Coolify smoke repeats the probe on every run: other policy types, patch, binding, cache and delete. A generator test requires exactly these two policy permissions. Revisit this once Authentik fixes the permission check or offers an API for proxy sessions.

## Mistake during implementation, and what follows from it

The first version granted only `view_policy`. The unit tests (a fake Authentik behind the real gate) passed, but the smoke failed: the gate got HTTP 500 and old sessions stayed valid. The fakes did not model Authentik's POST→`add_<model>` permission mapping, and the earlier live probe only covered the object permission, not the global one. Consequence: the unit tests cover the gate's logic only. That the gate works against Authentik is proven by the Coolify smoke alone (managed user, disable and remove during an outpost refresh storm, negative permission probe).

## Why a policy test instead of something else

- Authentik's session-end event alone: loses sessions, as described above.
- Shorter token validity: ends sessions only after the validity, and single-page-app requests break at every expiry.
- (b, rejected) Direct database access for the gate, e.g. a narrow database function: a new network to `authentik-db` plus credentials; broader than one fixed expression.
- An extra check on every forward-auth request in `lokyy-traefik`: new per-request dependency and attack surface.

## When the event gets lost (the "update storm")

On the QA stack the outpost refreshed about 8 times a minute for about 13 minutes after the S → M upgrade. Portal, gate and provisioning never save providers. The refreshes come from Authentik itself. Applying the blueprint saves every proxy provider, and each save queues an update message for the outpost (`outpost_send_update`, 117 tasks in 10 minutes on the QA stack). The embedded outpost works through that backlog one message at a time: it receives a trigger, waits about 7 s, then fetches `/outposts/instances/` and the providers (about 0.6 s). With a backlog of about 100 messages, the outpost keeps refreshing for minutes after every deploy or upgrade. It then falls back to its interval refresh. This is Authentik's own behaviour, and there is no workaround here. Session-end events sent during those minutes are lost, and this decision closes exactly that gap.

## Consequences

- The side effect of a "test" call is unusual. It is documented at the policy (generator comment), in the gate (`deploy/stack/authentik-gate/src/gate.ts`) and here.
- Only this policy may write. A generator test scans every policy expression in the Coolify, portal and stack blueprints for write and I/O calls: ORM writes, `setattr`, `cursor`/`execute`, `requests`, and `ak_*` helpers other than `ak_message`. This is a tripwire, not a proof: it catches the usual patterns, not every possible side effect. Reviews of new expressions stay necessary. A second generator test checks that `view_policy` and `add_policy` are the portal role's only policy permissions.
- The gate answers `user_not_found` for a missing user and `not_found` for an unknown route. The portal accepts only `user_not_found` as "already gone", so an older gate without the session endpoint makes the portal report an error instead of a silent success.
- The policy matches on `user_id` (UUID) or on the `sub` claim, so it keeps working if a provider's `sub_mode` changes.
- The portal deactivates the account before ending sessions on disable and on remove. A failed session end therefore never leaves an account that can log in again.
- The policy depends on Authentik internals: the `ProxySession` model and its `user_id` / claims. The Coolify smoke checks the behaviour end to end, including during an outpost refresh storm, so an Authentik upgrade that changes either detail fails the smoke.
