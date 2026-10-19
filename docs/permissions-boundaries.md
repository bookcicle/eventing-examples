# Eventing IAM permissions boundaries

In `IamMode: managed` (the default), both deployment templates attach a permissions boundary to every Eventing runtime role. In restricted accounts, select `IamMode: preprovisioned` to use platform-owned identities without modifying IAM; see the final section for that contract. Leaving the new parameters empty creates a separate, stack-managed boundary for each role. Existing deployments receive these boundaries on their next stack update. Boundaries limit permissions; the roles' existing scoped identity policies still grant the required operations.

| Stack / role | Default ceiling | Customer-managed override |
| --- | --- | --- |
| Regional `LambdaExecutionRole` | `firehose:PutRecordBatch` on this stack's delivery stream; `logs:CreateLogStream` / `logs:PutLogEvents` in its ingestion log group; own Lambda environment decryption | `LambdaPermissionsBoundaryArn` |
| Regional `FirehoseDeliveryRole` | Delivery S3 operations on this stack's bucket and objects; Encrypt/Decrypt/GenerateDataKey on `KmsKeyArn` only when configured | `FirehosePermissionsBoundaryArn` |
| Global `EdgeRouterRole` | Create/write only its own CloudWatch log groups and streams, including Lambda@Edge replicas across execution regions; own Lambda environment decryption | `EdgeRouterPermissionsBoundaryArn` |

The generated boundaries explicitly deny other actions and resources. This also prevents a later broad identity policy or a direct resource-policy session grant from overriding those denials while the boundary remains attached. Ingestion cannot read S3, assume other roles or administer IAM. Firehose cannot delete event objects or access another bucket/key. The edge router cannot access event storage or Firehose.

## Use the managed-mode defaults

Use the [coordinated root deployment](onboarding.md) and review its named-IAM capability acknowledgement. The underlying regional/global templates create their boundaries automatically. The templates generate unique managed-policy names. The global and regional stacks expose the effective ARNs as `EdgeRouterPermissionsBoundaryArn`, `LambdaPermissionsBoundaryArn` and `FirehosePermissionsBoundaryArn` outputs.

The CloudFormation execution identity needs permission to create/delete these managed policies, manage their policy versions, and attach/update role permissions boundaries (`iam:PutRolePermissionsBoundary`), in addition to the stack's existing deployment permissions. Restrict these administrative permissions to the specific Eventing roles/policies. Normal runtime roles receive none of those IAM permissions. Creating a managed policy also consumes the customer's IAM policy quota.

## Supply customer-managed boundaries in managed mode

Each override must be an existing customer-managed IAM policy ARN in the same AWS account and partition as the role. Policy paths are supported. AWS-managed policies and IAM role ARNs are rejected by parameter validation. IAM validates policy existence and attachment authorization during deployment.

IAM supports **one boundary per role**. Supplying an override replaces that role's generated boundary; it does not intersect two boundary policies. The stack does not create, attach as a grant, edit, version or delete the external policy. Other roles continue using their defaults unless individually overridden. Scoped identity policies remain in place even if a custom boundary is broad. A customer policy must preserve explicit denials if direct resource-policy session grants also need to be constrained.

Configure customer boundary ARNs in the coordinated root's desired-state declaration or Quick Launch form. Region-specific inputs bind to the individual regional roles automatically:

```json
{
  "EULambdaPermissionsBoundaryArn": "arn:aws:iam::111122223333:policy/organization/eventing/ingestion-eu",
  "EUFirehosePermissionsBoundaryArn": "arn:aws:iam::111122223333:policy/organization/eventing/delivery-eu",
  "EdgeRouterPermissionsBoundaryArn": "arn:aws:iam::111122223333:policy/organization/eventing/edge-router"
}
```

Use the `US` or `APAC` prefix for other enabled groups. Bind these values from your organization's policy resources in IaC; no inter-stack output copying or regional deployment commands are required. Set a value to an empty string in the reviewed declaration to restore that role's generated boundary. The root also supports `DeploymentPermissionsBoundaryArn` for its customer-owned StackSet execution role; its provisioning ceiling is separate from the narrower runtime ceilings. `AdministrationPermissionsBoundaryArn` and `LookupPermissionsBoundaryArn` allow customer boundaries on the root’s administration and read-only output lookup roles.

The table above uses the underlying regional template parameter names, which remain available for advanced existing-stack integrations. Customers should update the coordinated root rather than edit its managed child stacks or StackSets directly.

## Required permissions and region scope

All Lambda execution roles also need `kms:Decrypt` for their own environment startup encryption. The default ceilings restrict this to the AWS-managed `alias/aws/lambda` key in the account and the exact function encryption context (`kms:EncryptionContext:aws:lambda:FunctionArn`), including that function's versions. Edge replicas use the corresponding regional key/context. Explicit denials reject other keys/aliases and other function contexts. This is not permission to decrypt customer S3 data keys. Customer-owned roles/boundaries must preserve this startup permission; an unconditional deny of KMS decryption prevents Lambda from starting even with an AWS-managed key. The same rule applies to the read-only lookup role and seller registration function.


Custom policies must allow every operation in the table on the exact resources selected by the deployment. Ingestion's log group is pre-created, so its role does not need `logs:CreateLogGroup`. Firehose bucket permissions are `GetBucketLocation`, `ListBucket`, `ListBucketMultipartUploads`; object permissions are `AbortMultipartUpload`, `GetObject`, `PutObject`. The optional KMS ceiling includes `kms:Encrypt`, `kms:Decrypt`, `kms:GenerateDataKey`; the key policy must independently authorize the delivery role. Without `KmsKeyArn`, the default delivery boundary permits no KMS resources.

For the edge router, allow `logs:CreateLogGroup`, `logs:CreateLogStream` and `logs:PutLogEvents` for these account-scoped ARN patterns (replace the account, partition and deployment ID):

```json
[
  "arn:aws:logs:*:111122223333:log-group:/aws/lambda/us-east-1.ev-prod-acme-edge-router",
  "arn:aws:logs:*:111122223333:log-group:/aws/lambda/us-east-1.ev-prod-acme-edge-router:*",
  "arn:aws:logs:us-east-1:111122223333:log-group:/aws/lambda/ev-prod-acme-edge-router",
  "arn:aws:logs:us-east-1:111122223333:log-group:/aws/lambda/ev-prod-acme-edge-router:*"
]
```

Lambda@Edge keeps the `us-east-1.` function-name prefix in replica log group names, including when executing in another region. The unprefixed group covers direct execution of the original function in `us-east-1`. A custom policy that restricts all logging to the deployment region can break edge replica logs. See [AWS edge function logging](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/edge-functions-logs.html).

An auth plugin shares the ingestion role and its boundary. If a future custom plugin needs another AWS API, review and change both its scoped identity policy and its boundary; providing a boundary alone never grants additional access. The bundled JWT starter needs no network AWS API permissions.

## Protect the boundary outside the stack

These boundaries constrain compromised runtime credentials and accidental policy expansion while they remain attached. They do not protect against an account administrator or CloudFormation execution identity that can rewrite the template, remove the role boundary, or modify the boundary policy. A stack cannot make its own administrator untrusted.

For stronger enforcement, have a customer security administrator own the external boundary policies and control the CloudFormation execution role. Enforce the approved boundary ARNs on role creation/updates through IAM conditions such as `iam:PermissionsBoundary`; restrict boundary removal/replacement, policy version changes/default-version selection, `iam:PassRole`, and changes to the deployment role. Use organization SCPs where appropriate, with a controlled security-admin recovery path. Do not grant the deployment role permission to edit the externally owned boundary policy merely to attach it.

The boundaries cover the three Eventing runtime roles. They do not bound AWS service-linked roles or the deployment principal itself, isolate the auth subprocess from the ingestion process, prevent public HTTP egress, or guarantee isolation from every resource policy. Explicit denies have precedence, but custom policies and organizational guardrails require their own review. See [AWS boundary evaluation](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_boundaries.html) and [explicit deny with NotAction](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements_notaction.html).

## Verification and rollout

Use the public [runtime IAM policy reference](https://github.com/bookcicle/eventing-examples/blob/main/reference/runtime-iam-policies.json) and [configuration reference](https://github.com/bookcicle/eventing-examples/blob/main/reference/configuration.json) to prepare platform-owned roles. Symbolic CloudFormation references in the policy examples must be bound to your installation's resources in platform IaC. The service release supplied by your approved launch contains the deployable templates; you do not need a private source checkout or internal test tooling.

Review a non-production CloudFormation change set before applying an update, confirm the three effective boundary ARNs on the deployed roles, then smoke-test event ingestion, Firehose/S3 delivery, edge logging and optional CMK delivery. Use IAM policy simulation for approved and denied resource/action combinations as part of customer rollout. No live AWS deployment or IAM simulation is performed by the local tests.


## Pre-provisioned roles in restricted accounts

Use `IamMode: preprovisioned` on the coordinated root (and on leaf templates if managed independently). All buyer-side IAM roles and managed policies are skipped. Supply platform-owned administration/execution, lookup, edge and enabled-region ingestion/delivery roles, together with their expected boundary ARNs. The stack never updates those roles or their policy attachments, and deletion leaves them under platform ownership. In `managed` mode, the existing default/custom-boundary behavior is preserved.

Boundary parameters in pre-provisioned mode are declarations of the platform contract, not attachment requests or live verification. The platform must verify actual role boundaries, identity policies, trusts and drift through its IAM pipeline. Missing required declarations are rejected by template rules. The application deployment identity can be denied IAM creation/policy mutation while retaining narrowly scoped `iam:PassRole` for the existing roles.

Choose the approved root CloudFormation service role in Marketplace launch permissions; it is separate from `ExecutionRoleName`, which is the StackSet regional execution role. Users without delegated launch permission ask their platform team to conduct the Marketplace launch. The [onboarding guide](onboarding.md) maps every required role/boundary and describes platform preparation and update ownership.
