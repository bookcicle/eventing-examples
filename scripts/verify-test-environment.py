#!/usr/bin/env python3
"""Send one synthetic SDK event to a verified test stack and observe its regional S3 delivery."""
import argparse
import datetime as dt
import gzip
import io
import json
import os
import pathlib
import sys
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "sdk/python"))
from eventing_sdk import EventingClient

GROUPS = ("US", "EU", "APAC", "Additional1", "Additional2")
MAX_COMPRESSED = 8 * 1024 * 1024
MAX_DECODED = 64 * 1024 * 1024


def test_deployment(session, stack_name, control_region="us-east-1"):
    stack = session.client(
        "cloudformation", region_name=control_region
    ).describe_stacks(StackName=stack_name)["Stacks"][0]
    parameters = {p["ParameterKey"]: p["ParameterValue"] for p in stack["Parameters"]}
    if parameters.get("Stage") != "test":
        raise ValueError(
            "Refusing to send: the deployed CloudFormation Stage must be test"
        )
    if stack["StackStatus"] not in ("CREATE_COMPLETE", "UPDATE_COMPLETE"):
        raise ValueError("Test stack must complete successfully before verification")
    account = session.client("sts").get_caller_identity()["Account"]
    if stack["StackId"].split(":")[4] != account:
        raise ValueError("Test stack must belong to the active AWS account")
    outputs = {p["OutputKey"]: p["OutputValue"] for p in stack["Outputs"]}
    expected = "https://" + parameters["CustomDomainName"] + "/events"
    if outputs.get("EventsEndpoint") != expected:
        raise ValueError("Test endpoint must match the stack-owned hostname")
    buckets = []
    for group in GROUPS:
        region = parameters.get(group + "Region", "")
        if not region:
            continue
        bucket = outputs[group + "EventsBucket"]
        s3 = session.client("s3", region_name=region)
        tags = {
            p["Key"]: p["Value"]
            for p in s3.get_bucket_tagging(Bucket=bucket, ExpectedBucketOwner=account)[
                "TagSet"
            ]
        }
        location = (
            s3.get_bucket_location(Bucket=bucket, ExpectedBucketOwner=account)[
                "LocationConstraint"
            ]
            or "us-east-1"
        )
        if location == "EU":
            location = "eu-west-1"
        if (
            tags.get("Stage") != "test"
            or tags.get("DeploymentId") != parameters["DeploymentId"]
            or location != region
        ):
            raise ValueError("Test bucket tags and location must match the deployment")
        buckets.append((region, bucket, s3))
    if not buckets:
        raise ValueError("No enabled test ingestion regions")
    return parameters, expected, account, buckets


def contains_event(data, event_id):
    if len(data) > MAX_COMPRESSED:
        raise ValueError("Refusing unexpectedly large S3 object")
    if data.startswith(b"\x1f\x8b"):
        with gzip.GzipFile(fileobj=io.BytesIO(data)) as stream:
            data = stream.read(MAX_DECODED + 1)
    if len(data) > MAX_DECODED:
        raise ValueError("Refusing unexpectedly large decoded S3 object")
    for line in data.splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        event = row.get("event", row)
        if event.get("event_id") == event_id:
            return True
    return False


def verify(
    session,
    stack_name,
    *,
    control_region="us-east-1",
    timeout=600,
    interval=10,
    client_factory=EventingClient,
    clock=time.monotonic,
    sleep=time.sleep
):
    parameters, endpoint, account, buckets = test_deployment(
        session, stack_name, control_region
    )
    namespace = parameters.get("DefaultNamespace", "general")
    event_id = str(uuid.uuid4())
    started = dt.datetime.now(dt.timezone.utc)
    deadline = clock() + timeout
    token = os.environ.get("EVENTING_TEST_AUTH_TOKEN")
    client = client_factory(
        endpoint,
        environment="test",
        default_namespace=namespace,
        get_auth_token=(lambda: token) if token else None,
        queue_path=False,
    )
    try:
        client.track(
            {
                "event_id": event_id,
                "name": "eventing_sdk_integration_check",
                "properties": {"synthetic": True},
            }
        )
        result = client.flush()
        if not result["ok"]:
            raise RuntimeError(
                "Synthetic ingestion was not accepted; verify auth, namespace and quota configuration"
            )
    finally:
        client.close()
    seen = set()
    while clock() < deadline:
        for region, bucket, s3 in buckets:
            pages = s3.get_paginator("list_objects_v2").paginate(
                Bucket=bucket,
                Prefix=namespace + "/",
                ExpectedBucketOwner=account,
                PaginationConfig={"MaxItems": 2000, "PageSize": 1000},
            )
            for page in pages:
                for entry in page.get("Contents", []):
                    key = entry["Key"]
                    if (bucket, key) in seen or entry[
                        "LastModified"
                    ] < started - dt.timedelta(minutes=1):
                        continue
                    if entry["Size"] > MAX_COMPRESSED:
                        raise ValueError("Refusing unexpectedly large S3 object")
                    response = s3.get_object(
                        Bucket=bucket, Key=key, ExpectedBucketOwner=account
                    )
                    stream = response["Body"]
                    try:
                        data = stream.read(MAX_COMPRESSED + 1)
                    finally:
                        stream.close()
                    seen.add((bucket, key))
                    if contains_event(data, event_id):
                        return {
                            "event_id": event_id,
                            "stage": "test",
                            "region": region,
                            "bucket": bucket,
                            "key": key,
                            "s3_delivery_observed": True,
                        }
        sleep(min(interval, max(0, deadline - clock())))
    raise TimeoutError(
        "Ingestion accepted but synthetic event was not observed in S3 before the deadline"
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stack-name", required=True)
    parser.add_argument("--control-region", default="us-east-1")
    parser.add_argument("--profile")
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--interval", type=int, default=10)
    args = parser.parse_args()
    if not 1 <= args.interval <= args.timeout <= 1800:
        parser.error("Require 1 <= interval <= timeout <= 1800 seconds")
    import boto3

    session = (
        boto3.Session(profile_name=args.profile) if args.profile else boto3.Session()
    )
    result = verify(
        session,
        args.stack_name,
        control_region=args.control_region,
        timeout=args.timeout,
        interval=args.interval,
    )
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
