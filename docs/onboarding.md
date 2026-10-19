# Launch Eventing in your AWS account

Eventing is deployed as a versioned infrastructure package. Subscribe through AWS Marketplace, configure the deployment, review its permissions and let CloudFormation coordinate the resources. You do not deploy separate stacks, copy origin URLs or bind a distribution ID by hand.

## Who does what

Marketplace handles the subscription and guided launch. Your platform team approves the deployment permissions in your account. Application users do not need administrator access. CloudFormation creates and manages the regional stacks, the global front door and origin permissions. Bookcicle publishes the release artifacts and operates the subscription-registration service; it receives no standing role in your AWS account and no event payload access.

The registration service verifies the Marketplace token, product, buyer account and active agreement before offering the launch handoff. Subscription verification is separate from infrastructure readiness. A subscription does not mean the resources have already been deployed.

## Choose how your organization deploys

| Path | Who deploys | IAM ownership |
| --- | --- | --- |
| Approved self-service launch | A user permitted to launch the approved release and pass its designated CloudFormation service role | Set `IamMode` to `preprovisioned`; your platform team supplies the roles and boundary declarations. |
| Platform team's IaC pipeline | The platform team's existing deployment identity | Submit the desired configuration through your normal repository/review process. The pipeline binds role and boundary references automatically. You need no AWS deployment access. |
| Stack-managed IAM | An identity already permitted to create the scoped roles and policies | The default `IamMode: managed` creates role-specific IAM resources. Use only where organizational policy permits. |

No path requires giving an application user AdministratorAccess. A Marketplace subscription does not bypass IAM, SCPs or your organization's approval process. If you cannot pass an approved deployment role or create/update stacks, choose the platform pipeline path; do not create your own privileged role.

The CloudFormation **service role for the root stack** is selected in launch permissions or supplied by your platform's stack resource configuration. It is distinct from the StackSet administration/execution roles below and is not a root template parameter. Your platform team grants users only the approved launch/update permissions and narrowly scoped `iam:PassRole` when self-service is allowed. Stack update access must also be controlled because CloudFormation retains its service role for subsequent operations. See [AWS service roles](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-iam-servicerole.html).

## Configure and launch

1. Open your subscribed Eventing product in AWS Marketplace and choose **Set up your account / Configure and launch**. Quick Launch must be enabled for the product; if it is not available, your administrator can consume the approved release through your existing IaC pipeline.
2. Choose the target AWS account. Launch the coordinated entry point in **US East (N. Virginia), us-east-1**. The package creates ingestion resources in the selected regions automatically; you do not switch consoles to create each regional stack.
3. Enter a unique deployment ID, `dev` or `prod`, your first-party events hostname and an existing public Route53 hosted zone in the same account. Guided DNS setup requires that Route53 zone; an external DNS provider needs a separately reviewed DNS integration in your IaC pipeline.
4. Select the EU, US and APAC regions you need. An empty group is disabled. Leave residency mode at `fail_closed` unless your policy explicitly permits fallback. Initially use a non-production account and synthetic events.
5. Set exact browser origins, namespace policies, retention, concurrency and WAF controls. Optional KMS keys, alarm topics, auth layers and customer boundaries are specified for each region. Keep geographic enrichment and IP persistence decisions explicit.
6. Choose the platform-approved IAM mode and root CloudFormation service role. In `preprovisioned` mode, use the platform-provided role/boundary configuration; the root and its children create no IAM roles or policies. Review the versioned template and resource changes. The shared template still declares conditional IAM resources, so the launch flow may require a named-IAM capability acknowledgement; this grants no permissions. If launch is not delegated, hand the desired configuration to your platform pipeline instead.
7. Authorize deployment and watch the **root stack** in CloudFormation. It coordinates regional ingestion, output resolution, the global WAF/TLS/router and final distribution-only origin authorization. No placeholder distribution or manual output transfer is required.
8. Wait for root `CREATE_COMPLETE` or `UPDATE_COMPLETE`, then verify the deployment before connecting production traffic. DNS/certificate issuance and CloudFront propagation affect duration; there is no fixed 15-minute guarantee.

## Connect your application

Your events endpoint is derived from the hostname you declared:

```json
{
  "endpoint": "https://events.example.com/events",
  "namespace": "general"
}
```

Use `/secure` when authentication is required and an auth layer is configured. `/public` requires anonymous traffic; `/events` accepts either decision. Add the endpoint to your application's own environment configuration through its normal deployment pipeline. The root stack also exposes `EventsEndpoint` and `SecureEndpoint` for automatic bindings in your IaC system.

Send a small synthetic batch using the [Python, Rust or curl examples](runtime-examples.md). Confirm 202 acceptance and subsequent S3 delivery, view regional error/throttle/delivery metrics and edge logs, verify TLS and test direct-origin rejection. Root stack completion confirms provisioning, not a successful ingestion/delivery test. The metadata lookup resource does not read your event bucket or run data-plane smoke tests.

## Restricted accounts: platform-owned roles

Set `IamMode: preprovisioned`. The template requires these existing same-account identities and boundary declarations:

| Scope | Role input | Boundary input |
| --- | --- | --- |
| StackSet administration | `AdministrationRoleArn` | `AdministrationPermissionsBoundaryArn` |
| StackSet provisioning | `ExecutionRoleName` (name only, no path) | `DeploymentPermissionsBoundaryArn` |
| Read-only output lookup | `LookupRoleArn` | `LookupPermissionsBoundaryArn` |
| Edge routing | `EdgeRouterRoleArn` | `EdgeRouterPermissionsBoundaryArn` |
| Each enabled region group | `EULambdaRoleArn`, `USLambdaRoleArn`, `APACLambdaRoleArn` | Corresponding `EULambdaPermissionsBoundaryArn`, `USLambdaPermissionsBoundaryArn`, `APACLambdaPermissionsBoundaryArn` |
| Each enabled region group | `EUFirehoseRoleArn`, `USFirehoseRoleArn`, `APACFirehoseRoleArn` | Corresponding `EUFirehosePermissionsBoundaryArn`, `USFirehosePermissionsBoundaryArn`, `APACFirehosePermissionsBoundaryArn` |

Disabled region groups do not require identities. Missing required values are rejected by template rules before provisioning. Existing roles may use IAM paths, except the StackSet execution role, which is supplied as a role name. The application stack does not adopt, modify, attach policies to, detach boundaries from, or delete these external identities. Boundary ARNs declare the expected configuration; they do not attach a boundary or verify its live contents. Your platform's IAM policy/drift checks must verify that each role already has the declared boundary, trust and identity policies.

Before enabling self-service, the platform team prepares:

1. The approved root CloudFormation service role, with the scoped infrastructure and `iam:PassRole` permissions required for the supplied roles; no IAM role/policy creation is needed in this mode. StackSet execution needs regional infrastructure management plus passing the exact ingestion/delivery roles. The root service role passes the administration, lookup and edge roles.
2. The administration role trusting CloudFormation, restricted by your account and the installation's StackSet source ARNs; it may assume only the designated execution role. That execution role trusts only the administration role. See [AWS self-managed StackSet roles](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/stacksets-prereqs-self-managed.html).
3. The lookup role trusting Lambda, with read-only StackSet instance/child-stack metadata access for this installation and write access only to its lookup log group. The public [platform-role guide](https://github.com/bookcicle/eventing-examples/blob/main/docs/permissions-boundaries.md) describes the required permissions. The ingestion role trusts Lambda and writes only its Firehose stream and ingestion logs. The delivery role trusts Firehose and accesses only the installation bucket and optional KMS key. The edge role trusts both Lambda and Lambda@Edge and writes only the installation's router logs across execution regions.
4. Boundaries and identity policies managed in platform IaC. Use the public [runtime policy reference](https://github.com/bookcicle/eventing-examples/blob/main/reference/runtime-iam-policies.json) and review the deployment policies in your approved Marketplace release. Bind the same installation IDs, account, regions and deterministic resource names. A boundary limits permissions but does not grant them. Policies can reference resources before the resources exist. The regional bucket name is `${DeploymentId}-${Stage}-${AccountId}-${Region}`; the regional stream is `${DeploymentId}-${Stage}-events`, the function is `${DeploymentId}-${Stage}-ingest`, and ingestion logs use `/aws/lambda/${DeploymentId}-${Stage}-ingest`. The edge template receives `${DeploymentId}-${Stage}` as its deployment ID.
5. Any required AWS service-linked roles, service quotas, artifact-read access and the approved Route53 zone. Pre-provision first-use Lambda@Edge/CloudFront service-linked roles through platform IaC when the deployment role cannot create them. Organizational explicit denies still apply.

Bind these values from the platform IAM module into the Eventing root in the same pipeline; users should not copy role ARNs between consoles. Use dedicated roles per installation and distinct ingestion/delivery roles per enabled region. Keep role/boundary references stable across updates. Changing `IamMode` on an existing installation is a reviewed IAM ownership migration, not an ordinary settings change; do not flip it to transfer ownership of existing roles.

## Use your existing IaC pipeline

Consume the same release's **pinned root template URL** as a CloudFormation stack or as a resource in your existing CloudFormation/CDK/Terraform workflow. Store the desired parameters and approved release in source control. Your platform team supplies the root service role, chooses `IamMode` and binds the approved identities/boundaries from its IAM module. Your pipeline handles plan/change-set review, deployment and output bindings. Application users only need permission to propose configuration changes in that workflow, not administrator or direct AWS deployment access. The package does not require a buyer-side shell script or a sequence of AWS CLI commands.

These are example **root stack parameters**, not commands or separate per-stack outputs:

```json
{
  "DeploymentId": "ev-acme",
  "Stage": "prod",
  "CustomDomainName": "events.example.com",
  "HostedZoneId": "Z0123456789EXAMPLE",
  "EURegion": "eu-west-1",
  "USRegion": "us-east-1",
  "APACRegion": "",
  "ResidencyMode": "fail_closed",
  "AllowedCorsOrigins": "https://app.example.com",
  "LambdaReservedConcurrency": "100",
  "RetentionDays": "365"
}
```

Only regions present in the approved release are offered. This package currently supports selected standard commercial AWS regions in one account per installation. It does not enroll an organization or deploy to arbitrary external accounts. Use separate root installations and accounts for production and non-production.

Do not adopt an existing independently deployed Eventing installation by creating another root with the same deployment ID. Review a migration/import plan first; the coordinated package creates and owns its own child stacks and authorization resources.

## Updates and removal

Update the existing root stack through the same IaC workflow, selecting the next approved immutable release and reviewing its change set. Do not update managed StackSets or child stacks independently. Settings are root parameters; regional auth layer/key/boundary ARNs should be bound from your application's infrastructure outputs automatically, rather than copied by an operator.

Treat deployment ID, stage and enabled-region changes as infrastructure migrations. Removing or replacing a regional stack retains its S3 bucket but does not migrate historical events or repoint downstream analytics automatically. Review old retained resources and their costs.

Stop producers and drain Firehose buffers before removal; retention protects persisted objects, not unflushed deliveries. Deleting the root removes its managed infrastructure, while event buckets and their TLS-only bucket policies remain retained. Lambda@Edge functions and published versions are deliberately retained because replica cleanup is asynchronous; an administrator removes them after AWS finishes replication cleanup. Subscription cancellation and infrastructure removal are separate actions. Retained data/storage can continue incurring charges.

## Public supporting project

The [eventing-examples repository](https://github.com/bookcicle/eventing-examples) contains runnable producers, browser SDK source, demo/JWT auth starters, public contract types and customer configuration/IAM references. Your organization needs no access to the private service implementation. Deployable releases come from your approved Marketplace launch or platform pipeline, not an examples checkout.

## Reference

The [configuration guide](configuration.md) describes root settings and the underlying templates. The [permissions boundary guide](permissions-boundaries.md) explains runtime ceilings and customer policy ownership. Local auth development remains documented in the [auth-layer guide](auth-layer.md); its build/package commands are developer tasks, not the customer onboarding sequence.
