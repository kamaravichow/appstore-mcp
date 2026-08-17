---
name: app-store-connect
description: Use the App Store Connect MCP server to inspect and manage apps, versions, metadata, in-app purchases, subscriptions, TestFlight, reviews, users, provisioning, reports, Xcode Cloud, Game Center, webhooks, and other resources supported by Apple's App Store Connect API.
---

# App Store Connect

Use this skill when a task concerns App Store Connect data or actions through the `asc_*` MCP tools.

## Start safely

1. For configuration or permission problems, call `asc_auth_status` with `verify: true`.
2. Resolve names, bundle IDs, SKUs, and product IDs to App Store Connect resource IDs before changing anything.
3. Read current state before every write.
4. Treat all writes as production changes. Never infer permission to mutate from a read, diagnosis, audit, or planning request.

## Choose a tool

- Use `asc_list_apps`, `asc_get_app`, `asc_list_in_app_purchases`, `asc_list_subscription_groups`, and `asc_list_subscriptions` for their common cases.
- For any other capability, call `asc_search_operations` with the user's intent.
- Call `asc_describe_operation` on the chosen operation before using its endpoint. Use its exact parameter names and request-body schema.
- Use `asc_api_get` for documented JSON reads.
- Use `asc_download` for reports, gzip, certificates, profiles, diagnostics, or other file responses.
- Use `asc_api_post`, `asc_api_patch`, and `asc_api_delete` only after the user requested that production change. Deletes require `confirm: true`.
- Use `asc_upload_asset` for Apple's traditional reserve/upload/commit asset workflow. Use `asc_upload_parts` when a resource has a specialized commit schema.

## Construct requests

- Supply paths beginning with `/v1/`; replace `{id}` placeholders with percent-encoded resource IDs.
- Put filters and options in `query`, with exact Apple keys such as `filter[bundleId]`, `fields[apps]`, `include`, `sort`, and `limit`.
- Arrays serialize as comma-separated query values.
- POST/PATCH bodies must be full JSON:API documents. Preserve the resource `type`; PATCH bodies also need the exact `id`.
- Prefer narrow fields, filters, and page limits. Enable pagination only when the task needs the whole collection.

## Verify writes

After a successful write, re-read the affected resource. For asynchronous operations, report the current processing state and the exact resource ID needed to poll. Asset upload success means the commit succeeded; processing is complete only when Apple's delivery state reaches `COMPLETE`.

## Respect API boundaries

If operation search returns nothing, do not invent an endpoint. Explain that the action may not be exposed by App Store Connect API, or update the bundled specification with `npm run sync:openapi` if Apple recently added it. Do not substitute Apple's separate App Store Server API without explicitly expanding the task scope.
