from __future__ import annotations

import pytest

from memory_core.record_schemas import (
    RecordSchemaValidationIssue,
    normalize_registered_payload,
)


def recipe_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "recipe_name": "  氣泡測試酒  ",
        "recipe_origin": "original",
        "status": "tested",
        "ingredients": [
            {"name": " 琴酒 ", "amount": 45, "unit": "ml", "note": None},
            {"name": "氣泡水", "amount": None, "unit": "top_up", "note": None},
        ],
        "method": "build",
        "steps": [" 加入冰塊與琴酒 ", "以氣泡水補滿"],
        "ice": "cubed",
        "glassware": "highball",
        "garnish": [],
        "taste_profile": {
            "sweetness": 2,
            "acidity": 2,
            "bitterness": 1,
            "alcohol_presence": 4,
            "carbonation": 4,
        },
        "evaluation": None,
        "tags": [" 氣泡 ", "清爽", "氣泡"],
        "parent_recipe_ref": None,
    }
    payload.update(overrides)
    return payload


def tasting_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "cocktail_name": "氣泡測試酒",
        "recipe_ref": "record:recipe-1",
        "recipe_version": 1,
        "ingredients_snapshot": [],
        "recipe_changes": [],
        "servings": 1,
        "rating": 8.5,
        "verdict": "good",
        "tasting_notes": "氣泡感明顯。",
        "repeat_intent": "definitely",
        "rank_note": None,
        "observed_taste_profile": {
            "sweetness": 2,
            "acidity": 2,
            "bitterness": 1,
            "alcohol_presence": 4,
            "carbonation": 4,
        },
    }
    payload.update(overrides)
    return payload


def normalize_recipe(payload: dict[str, object]) -> dict[str, object]:
    return normalize_registered_payload(
        schema_name="cocktail_recipe",
        schema_version=1,
        domain="lifestyle.cocktail",
        kind="fact",
        payload=payload,
    )


def normalize_tasting(payload: dict[str, object]) -> dict[str, object]:
    return normalize_registered_payload(
        schema_name="cocktail_tasting",
        schema_version=1,
        domain="lifestyle.cocktail",
        kind="event",
        payload=payload,
    )


def assert_schema_error(
    *,
    expected_code: str,
    expected_field: str,
    callback: object,
) -> None:
    assert callable(callback)
    with pytest.raises(RecordSchemaValidationIssue) as captured:
        callback()
    assert captured.value.code == expected_code
    assert captured.value.field == expected_field


def test_recipe_payload_is_normalized_and_deduplicates_tags() -> None:
    normalized = normalize_recipe(recipe_payload())

    assert normalized["recipe_name"] == "氣泡測試酒"
    ingredients = normalized["ingredients"]
    assert isinstance(ingredients, list)
    assert ingredients[0]["name"] == "琴酒"
    assert normalized["steps"] == ["加入冰塊與琴酒", "以氣泡水補滿"]
    assert normalized["tags"] == ["氣泡", "清爽"]
    assert "rating" not in normalized
    assert "repeat_intent" not in normalized


def test_draft_recipe_allows_unknown_amount_and_empty_steps() -> None:
    normalized = normalize_recipe(
        recipe_payload(
            status="draft",
            ingredients=[{"name": "未知材料", "amount": None, "unit": None}],
            steps=[],
        )
    )
    assert normalized["steps"] == []


@pytest.mark.parametrize(
    ("ingredients", "code", "field"),
    [
        ([], "cocktail_ingredient_required", "payload.ingredients"),
        (
            [{"name": "琴酒", "amount": -1, "unit": "ml"}],
            "invalid_ingredient_amount",
            "payload.ingredients[0].amount",
        ),
        (
            [{"name": "琴酒", "amount": 45, "unit": None}],
            "invalid_ingredient_amount_unit_pair",
            "payload.ingredients[0].unit",
        ),
        (
            [{"name": "氣泡水", "amount": 45, "unit": "top_up"}],
            "invalid_ingredient_amount_unit_pair",
            "payload.ingredients[0].amount",
        ),
    ],
)
def test_recipe_rejects_invalid_ingredients(
    ingredients: list[dict[str, object]],
    code: str,
    field: str,
) -> None:
    assert_schema_error(
        expected_code=code,
        expected_field=field,
        callback=lambda: normalize_recipe(recipe_payload(ingredients=ingredients)),
    )


def test_tested_recipe_requires_steps() -> None:
    assert_schema_error(
        expected_code="cocktail_steps_required",
        expected_field="payload.steps",
        callback=lambda: normalize_recipe(recipe_payload(steps=[])),
    )


@pytest.mark.parametrize(
    ("overrides", "code", "field"),
    [
        (
            {"taste_profile": {"sweetness": 6}},
            "invalid_taste_profile_score",
            "payload.taste_profile.sweetness",
        ),
        (
            {"method": "boil"},
            "invalid_cocktail_method",
            "payload.method",
        ),
        (
            {"unexpected": True},
            "invalid_cocktail_schema",
            "payload.unexpected",
        ),
    ],
)
def test_recipe_rejects_invalid_payload_fields(
    overrides: dict[str, object],
    code: str,
    field: str,
) -> None:
    assert_schema_error(
        expected_code=code,
        expected_field=field,
        callback=lambda: normalize_recipe(recipe_payload(**overrides)),
    )


def test_tasting_requires_recipe_reference_and_version_as_a_pair() -> None:
    assert_schema_error(
        expected_code="invalid_recipe_version",
        expected_field="payload.recipe_version",
        callback=lambda: normalize_tasting(tasting_payload(recipe_version=None)),
    )
    assert_schema_error(
        expected_code="invalid_recipe_reference",
        expected_field="payload.recipe_ref",
        callback=lambda: normalize_tasting(tasting_payload(recipe_ref=None, recipe_version=1)),
    )


def test_improvised_tasting_requires_ingredient_snapshot() -> None:
    assert_schema_error(
        expected_code="cocktail_ingredient_required",
        expected_field="payload.ingredients_snapshot",
        callback=lambda: normalize_tasting(
            tasting_payload(
                recipe_ref=None,
                recipe_version=None,
                ingredients_snapshot=[],
            )
        ),
    )
    normalized = normalize_tasting(
        tasting_payload(
            recipe_ref=None,
            recipe_version=None,
            ingredients_snapshot=[{"name": "琴酒", "amount": 45, "unit": "ml", "note": None}],
        )
    )
    assert normalized["recipe_ref"] is None


def test_tasting_rejects_invalid_rating_and_profile() -> None:
    assert_schema_error(
        expected_code="invalid_cocktail_rating",
        expected_field="payload.rating",
        callback=lambda: normalize_tasting(tasting_payload(rating=10.5)),
    )
    assert_schema_error(
        expected_code="invalid_cocktail_rating",
        expected_field="payload.rating",
        callback=lambda: normalize_tasting(tasting_payload(rating=8.3)),
    )
    assert_schema_error(
        expected_code="invalid_taste_profile_score",
        expected_field="payload.observed_taste_profile.acidity",
        callback=lambda: normalize_tasting(tasting_payload(observed_taste_profile={"acidity": 0})),
    )


def test_preference_payload_normalizes_lists() -> None:
    normalized = normalize_registered_payload(
        schema_name="cocktail_preference",
        schema_version=1,
        domain="lifestyle.cocktail",
        kind="state",
        payload={
            "preferred_flavors": [" 酸甜 ", "果香", "酸甜"],
            "disliked_flavors": [],
            "perceived_strength": "medium_to_strong",
            "alcohol_requirement": " 能感受到酒體 ",
            "avoid_characteristics": [],
            "presentation_preferences": ["精緻杯型"],
            "confirmed_favorite_recipe_refs": [],
            "notes": None,
        },
    )
    assert normalized["preferred_flavors"] == ["酸甜", "果香"]
    assert normalized["alcohol_requirement"] == "能感受到酒體"


def test_registry_enforces_envelope_and_preserves_unregistered_schemas() -> None:
    assert_schema_error(
        expected_code="invalid_record_schema_envelope",
        expected_field="domain",
        callback=lambda: normalize_registered_payload(
            schema_name="cocktail_recipe",
            schema_version=1,
            domain="general",
            kind="fact",
            payload=recipe_payload(),
        ),
    )
    assert_schema_error(
        expected_code="unsupported_record_schema_version",
        expected_field="schema_version",
        callback=lambda: normalize_registered_payload(
            schema_name="cocktail_recipe",
            schema_version=2,
            domain="lifestyle.cocktail",
            kind="fact",
            payload=recipe_payload(),
        ),
    )
    generic = {"free": {"nested": ["value"]}}
    assert (
        normalize_registered_payload(
            schema_name="generic",
            schema_version=1,
            domain="general",
            kind="note",
            payload=generic,
        )
        == generic
    )
