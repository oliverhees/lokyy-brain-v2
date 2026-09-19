# ADR 0002 — End forward-auth (outpost) sessions through a fixed blueprint policy

- Status: accepted (lead decision (a), security audit of 2ce91e6 passed without High/Critical)
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
4. The portal's service-account role gets `authentik_policies.view_policy`, because the test API requires it. This permission is read-only: it does not grant changing, creating or deleting policies.

## Why the permission is global

The intended scope was an object permission on exactly this policy. On Authentik 2026.8.2 the test endpoint checks `has_perm("authentik_policies.view_policy", <ExpressionPolicy>)`. With only an object permission, the endpoint fails with `WrongAppError`: the permission's app label is `authentik_policies`, the object's is `authentik_policies_expression`. The result is HTTP 500, verified on the QA stack. An object permission on the child model (`view_expressionpolicy`) lets the service account list the policy, but not test it. The global permission is therefore the only working option on this version.

With the global permission, the service account (token held only by authentik-gate) can read every policy and evaluate any policy for users it can view. Side effects are limited to this one policy. The policy refuses privileged and unmanaged accounts, and the gate refuses them before calling it. Revisit this once Authentik fixes the object-permission check or offers an API for proxy sessions.

## Why a policy test instead of something else

- Authentik's session-end event alone: loses sessions, as described above.
- Shorter token validity: ends sessions only after the validity, and single-page-app requests break at every expiry.
- (b, rejected) Direct database access for the gate, e.g. a narrow database function: a new network to `authentik-db` plus credentials; broader than one fixed expression.
- An extra check on every forward-auth request in `lokyy-traefik`: new per-request dependency and attack surface.

## When the event gets lost (the "update storm")

On the QA stack the outpost refreshed about 8 times a minute for about 13 minutes after the S → M upgrade. Portal, gate and provisioning never save providers. The refreshes come from Authentik itself. Applying the blueprint saves every proxy provider, and each save queues an update message for the outpost (`outpost_send_update`, 117 tasks in 10 minutes on the QA stack). The embedded outpost works through that backlog one message at a time: it receives a trigger, waits about 7 s, then fetches `/outposts/instances/` and the providers (about 0.6 s). With a backlog of about 100 messages, the outpost keeps refreshing for minutes after every deploy or upgrade. It then falls back to its interval refresh. This is Authentik's own behaviour, and there is no workaround here. Session-end events sent during those minutes are lost, and this decision closes exactly that gap.

## Consequences

- The side effect of a "test" call is unusual. It is documented at the policy (generator comment), in the gate (`deploy/stack/authentik-gate/src/gate.ts`) and here.
- Only this policy may write. A generator test scans every policy expression in the Coolify, portal and stack blueprints for write and I/O calls: ORM writes, `setattr`, `cursor`/`execute`, `requests`, and `ak_*` helpers other than `ak_message`. This is a tripwire, not a proof: it catches the usual patterns, not every possible side effect. Reviews of new expressions stay necessary. A second generator test checks that `view_policy` is the portal role's only policy permission (read only).
- The gate answers `user_not_found` for a missing user and `not_found` for an unknown route. The portal accepts only `user_not_found` as "already gone", so an older gate without the session endpoint makes the portal report an error instead of a silent success.
- The policy matches on `user_id` (UUID) or on the `sub` claim, so it keeps working if a provider's `sub_mode` changes.
- The portal deactivates the account before ending sessions on disable and on remove. A failed session end therefore never leaves an account that can log in again.
- The policy depends on Authentik internals: the `ProxySession` model and its `user_id` / claims. The Coolify smoke checks the behaviour end to end, including during an outpost refresh storm, so an Authentik upgrade that changes either detail fails the smoke.
