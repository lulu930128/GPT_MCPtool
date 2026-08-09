from __future__ import annotations

from sqlalchemy import select

from memory_core.models import (
    BatchItemOperation,
    CandidateBatch,
    CandidateBatchRevision,
    CandidateItem,
    ClientCredential,
    CollectionMember,
    MemoryCandidate,
    MemoryCollection,
    Record,
)


def test_batch_items_scope_operation_ids_and_collection_membership(database) -> None:
    with database.session_factory() as session:
        credential = session.scalar(
            select(ClientCredential).where(ClientCredential.name == "admin")
        )
        assert credential is not None

        candidate = MemoryCandidate(
            candidate_kind="batch",
            summary="Two media items",
            operation=None,
            target_type=None,
            target_id=None,
            base_version=None,
            proposed_content={},
            source_type="manual",
            source_reference=None,
            source_client_id=credential.id,
            idempotency_key="batch-models-1",
            content_hash="a" * 64,
            review_digest="sha256:v1:" + ("b" * 64),
            validation_result={"valid": True},
            risk_flags=[],
            status="pending",
        )
        batch = CandidateBatch(
            candidate=candidate,
            profile_id="media.experience",
            profile_version=1,
            profile_hash="sha256:" + ("c" * 64),
            normalizer_version="1",
            input_hash="sha256:" + ("d" * 64),
            current_revision_no=1,
            plan_state="ready",
            review_state="pending",
            execution_state="not_started",
            item_count=2,
        )
        revision = CandidateBatchRevision(
            batch=batch,
            revision_no=1,
            input_snapshot={"items": [{"title": "A"}, {"title": "B"}]},
            input_hash=batch.input_hash,
            plan_snapshot={"items": [{"unit_key": "a"}, {"unit_key": "b"}]},
            plan_hash="sha256:" + ("e" * 64),
        )
        first = CandidateItem(
            batch=batch,
            batch_revision=revision,
            unit_key="media:galgame:a",
            position=0,
            source_index=0,
            input_snapshot={"title": "A"},
            normalized_snapshot={"title": "A"},
            input_hash="sha256:" + ("f" * 64),
            plan_hash="sha256:" + ("1" * 64),
            decision="create",
        )
        second = CandidateItem(
            batch=batch,
            batch_revision=revision,
            unit_key="media:galgame:b",
            position=1,
            source_index=1,
            input_snapshot={"title": "B"},
            normalized_snapshot={"title": "B"},
            input_hash="sha256:" + ("2" * 64),
            plan_hash="sha256:" + ("3" * 64),
            decision="create",
        )
        first.operations.append(
            BatchItemOperation(
                op_id="record",
                position=0,
                change_type="record_create",
                change_data={"title": "A"},
            )
        )
        second.operations.append(
            BatchItemOperation(
                op_id="record",
                position=0,
                change_type="record_create",
                change_data={"title": "B"},
            )
        )
        session.add(candidate)
        session.flush()

        record = Record(
            kind="state",
            domain="media.galgame",
            title="A",
            schema_name="media_experience",
            schema_version=1,
            created_by_client_id=credential.id,
        )
        collection = MemoryCollection(
            key="media.galgame.completed",
            name="Galgame 完食清單",
            domain="media.galgame",
            created_by_client_id=credential.id,
        )
        session.add_all([record, collection])
        session.flush()
        collection.members.append(
            CollectionMember(
                record_id=record.id,
                source_candidate_item_id=first.id,
            )
        )
        session.commit()

        stored = session.scalar(
            select(CandidateBatch).where(CandidateBatch.candidate_id == candidate.id)
        )
        assert stored is not None
        assert [item.unit_key for item in stored.items] == [
            "media:galgame:a",
            "media:galgame:b",
        ]
        assert [item.operations[0].op_id for item in stored.items] == ["record", "record"]
        assert collection.members[0].record_id == record.id
