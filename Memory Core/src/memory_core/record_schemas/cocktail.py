from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator
from pydantic_core import PydanticCustomError

from memory_core.record_schemas.base import (
    RecordSchemaValidationIssue,
    payload_field_path,
    scalar_error_value,
)

IngredientUnit = Literal[
    "ml",
    "oz",
    "tsp",
    "tbsp",
    "dash",
    "drop",
    "piece",
    "top_up",
    "to_taste",
]
StableRecordRef = Annotated[str, Field(min_length=8, max_length=200, pattern=r"^record:[^:]+$")]
Rating = Annotated[float, Field(ge=0, le=10, multiple_of=0.5)]
TasteScore = Annotated[int, Field(ge=1, le=5)]


class CocktailPayloadModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        str_strip_whitespace=True,
        allow_inf_nan=False,
    )


def _normalize_unique_text_list(value: Any) -> Any:
    if not isinstance(value, list):
        return value
    normalized: list[Any] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, str):
            normalized.append(item)
            continue
        stripped = item.strip()
        if not stripped or stripped in seen:
            continue
        normalized.append(stripped)
        seen.add(stripped)
    return normalized


class CocktailIngredient(CocktailPayloadModel):
    name: str = Field(
        min_length=1,
        max_length=120,
        description="Ingredient name, trimmed and non-empty.",
    )
    amount: float | None = Field(
        gt=0,
        description="Positive quantity, or null when unknown, top_up, or to_taste.",
    )
    unit: IngredientUnit | None = Field(
        description="Supported measurement unit, or null when unknown."
    )
    note: str | None = Field(default=None, description="Optional ingredient-specific note.")

    @model_validator(mode="after")
    def validate_amount_unit_pair(self) -> CocktailIngredient:
        if self.amount is not None and self.unit is None:
            raise PydanticCustomError(
                "invalid_ingredient_amount_unit_pair",
                "unit is required when amount is provided.",
                {"field": "unit", "example": "ml"},
            )
        if self.amount is not None and self.unit in {"top_up", "to_taste"}:
            raise PydanticCustomError(
                "invalid_ingredient_amount_unit_pair",
                "amount must be null when unit is top_up or to_taste.",
                {"field": "amount", "example": None},
            )
        if self.amount is None and self.unit in {"top_up", "to_taste"}:
            return self
        return self


class CocktailTasteProfile(CocktailPayloadModel):
    sweetness: TasteScore | None = Field(default=None, description="Sweetness score from 1 to 5.")
    acidity: TasteScore | None = Field(default=None, description="Acidity score from 1 to 5.")
    bitterness: TasteScore | None = Field(
        default=None,
        description="Bitterness score from 1 to 5.",
    )
    alcohol_presence: TasteScore | None = Field(
        default=None,
        description="Perceived alcohol presence from 1 to 5.",
    )
    carbonation: TasteScore | None = Field(
        default=None,
        description="Carbonation score from 1 to 5.",
    )


class CocktailRecipePayloadV1(CocktailPayloadModel):
    recipe_name: str = Field(
        min_length=1,
        max_length=120,
        description="Reusable cocktail recipe name.",
    )
    recipe_origin: Literal["classic", "adapted", "original"] = Field(
        description="Whether the recipe is classic, adapted, or original."
    )
    status: Literal["draft", "tested", "favorite", "retired"] = Field(
        description="Recipe lifecycle inside the cocktail domain."
    )
    ingredients: list[CocktailIngredient] = Field(
        min_length=1,
        max_length=100,
        description="Complete reusable ingredient list.",
    )
    method: Literal["build", "shake", "stir", "blend", "layer", "muddle", "clarify", "other"] = (
        Field(description="Primary preparation method.")
    )
    steps: list[str] = Field(
        max_length=100,
        description="Ordered preparation steps; tested and favorite recipes require one.",
    )
    ice: Literal["none", "cubed", "crushed", "large_cube", "sphere", "frozen"] | None = Field(
        default=None, description="Ice style used by the recipe."
    )
    glassware: str | None = Field(
        default=None,
        max_length=120,
        description="Recommended glassware.",
    )
    garnish: list[str] = Field(
        default_factory=list,
        max_length=50,
        description="Trimmed, de-duplicated garnish items.",
    )
    taste_profile: CocktailTasteProfile | None = Field(
        default=None,
        description="Expected recipe taste profile using optional 1-to-5 scores.",
    )
    evaluation: str | None = Field(
        default=None,
        description="Recipe-level evaluation, separate from one tasting rating.",
    )
    tags: list[str] = Field(
        default_factory=list,
        max_length=50,
        description="Trimmed, de-duplicated search tags.",
    )
    parent_recipe_ref: StableRecordRef | None = Field(
        default=None,
        description="Optional active Cocktail Recipe reference from which this recipe derives.",
    )

    @field_validator("steps", "garnish", "tags", mode="before")
    @classmethod
    def normalize_text_lists(cls, value: Any) -> Any:
        return _normalize_unique_text_list(value)

    @model_validator(mode="after")
    def validate_steps(self) -> CocktailRecipePayloadV1:
        if self.status in {"tested", "favorite"} and not self.steps:
            raise PydanticCustomError(
                "cocktail_steps_required",
                "tested and favorite recipes require at least one preparation step.",
                {"field": "steps", "example": ["Shake with ice and strain."]},
            )
        return self


class CocktailTastingPayloadV1(CocktailPayloadModel):
    cocktail_name: str = Field(
        min_length=1,
        max_length=120,
        description="Name used for this actual tasting event.",
    )
    recipe_ref: StableRecordRef | None = Field(
        default=None,
        description="Optional Cocktail Recipe record:<id> used for this tasting.",
    )
    recipe_version: int | None = Field(
        default=None,
        ge=1,
        description="Exact referenced recipe revision used for historical reconstruction.",
    )
    ingredients_snapshot: list[CocktailIngredient] = Field(
        default_factory=list,
        max_length=100,
        description="Actual ingredients; required for an improvised tasting without recipe_ref.",
    )
    recipe_changes: list[str] = Field(
        default_factory=list,
        max_length=100,
        description="Differences from the referenced recipe for this tasting only.",
    )
    servings: float | None = Field(
        default=None,
        gt=0,
        description="Positive number of servings when known.",
    )
    rating: Rating | None = Field(
        default=None,
        description="Tasting rating from 0 to 10 in 0.5 increments.",
    )
    verdict: Literal["favorite", "good", "neutral", "poor", "failed"] | None = Field(
        default=None,
        description="Categorical verdict for this one tasting.",
    )
    tasting_notes: str | None = Field(
        default=None,
        description="Free-form observations from this tasting.",
    )
    repeat_intent: Literal["definitely", "maybe", "no"] | None = Field(
        default=None,
        description="Whether the user intends to repeat this tasting.",
    )
    rank_note: str | None = Field(
        default=None,
        description="Relative ranking note without inventing an exact rank.",
    )
    observed_taste_profile: CocktailTasteProfile | None = Field(
        default=None,
        description="Taste profile observed in this tasting, distinct from the recipe profile.",
    )

    @field_validator("recipe_changes", mode="before")
    @classmethod
    def normalize_recipe_changes(cls, value: Any) -> Any:
        return _normalize_unique_text_list(value)

    @model_validator(mode="after")
    def validate_recipe_snapshot(self) -> CocktailTastingPayloadV1:
        if self.recipe_ref is not None and self.recipe_version is None:
            raise PydanticCustomError(
                "invalid_recipe_version",
                "recipe_version is required when recipe_ref is provided.",
                {"field": "recipe_version", "example": 1},
            )
        if self.recipe_ref is None and self.recipe_version is not None:
            raise PydanticCustomError(
                "invalid_recipe_reference",
                "recipe_ref is required when recipe_version is provided.",
                {"field": "recipe_ref", "example": "record:<recipe-id>"},
            )
        if self.recipe_ref is None and not self.ingredients_snapshot:
            raise PydanticCustomError(
                "cocktail_ingredient_required",
                "An improvised tasting requires at least one ingredients_snapshot item.",
                {
                    "field": "ingredients_snapshot",
                    "example": [{"name": "Gin", "amount": 45, "unit": "ml"}],
                },
            )
        return self


class CocktailPreferencePayloadV1(CocktailPayloadModel):
    preferred_flavors: list[str] = Field(
        default_factory=list,
        max_length=100,
        description="User-confirmed long-term preferred flavor descriptions.",
    )
    disliked_flavors: list[str] = Field(
        default_factory=list,
        max_length=100,
        description="User-confirmed long-term disliked flavor descriptions.",
    )
    perceived_strength: Literal["light", "medium", "medium_to_strong", "strong"] | None = Field(
        default=None, description="Preferred perceived alcohol strength."
    )
    alcohol_requirement: str | None = Field(
        default=None,
        description="User-confirmed description of the desired alcohol presence.",
    )
    avoid_characteristics: list[str] = Field(
        default_factory=list,
        max_length=100,
        description="User-confirmed characteristics to avoid.",
    )
    presentation_preferences: list[str] = Field(
        default_factory=list,
        max_length=100,
        description="User-confirmed presentation preferences.",
    )
    confirmed_favorite_recipe_refs: list[StableRecordRef] = Field(
        default_factory=list,
        max_length=100,
        description=(
            "Active or retired Cocktail Recipe references explicitly confirmed as favorites."
        ),
    )
    notes: str | None = Field(
        default=None,
        description="Additional user-confirmed long-term preference notes.",
    )

    @field_validator(
        "preferred_flavors",
        "disliked_flavors",
        "avoid_characteristics",
        "presentation_preferences",
        "confirmed_favorite_recipe_refs",
        mode="before",
    )
    @classmethod
    def normalize_lists(cls, value: Any) -> Any:
        return _normalize_unique_text_list(value)


COCKTAIL_ERROR_CODES = frozenset(
    {
        "cocktail_recipe_name_required",
        "cocktail_ingredient_required",
        "cocktail_steps_required",
        "invalid_ingredient_amount",
        "invalid_ingredient_unit",
        "invalid_ingredient_amount_unit_pair",
        "invalid_cocktail_method",
        "invalid_taste_profile_score",
        "invalid_cocktail_rating",
        "invalid_repeat_intent",
        "invalid_recipe_reference",
        "invalid_recipe_version",
        "recipe_reference_cycle",
        "tasting_time_required",
        "cocktail_preference_singleton_conflict",
        "invalid_favorite_recipe_reference",
        "invalid_cocktail_schema",
    }
)


def _error_code_for_location(
    schema_name: str,
    location: tuple[object, ...],
    error_type: str,
) -> tuple[str, str, object | None]:
    last = str(location[-1]) if location else ""
    joined = ".".join(str(part) for part in location)
    if error_type in COCKTAIL_ERROR_CODES:
        return error_type, "Invalid cocktail value.", None
    if schema_name == "cocktail_recipe" and last == "recipe_name":
        return (
            "cocktail_recipe_name_required",
            "recipe_name must not be empty.",
            "Example cocktail",
        )
    if "ingredients" in joined and (
        last in {"ingredients", "ingredients_snapshot", "name"} or error_type == "too_short"
    ):
        return (
            "cocktail_ingredient_required",
            "At least one ingredient with a non-empty name is required.",
            [{"name": "Gin", "amount": 45, "unit": "ml"}],
        )
    if last == "amount" and error_type in {"greater_than", "finite_number"}:
        return "invalid_ingredient_amount", "amount must be greater than 0 when provided.", 45
    if last == "unit" and error_type == "literal_error":
        return "invalid_ingredient_unit", "unit is not a supported cocktail unit.", "ml"
    if last == "method":
        return "invalid_cocktail_method", "method is not supported.", "shake"
    if last in {"sweetness", "acidity", "bitterness", "alcohol_presence", "carbonation"}:
        return (
            "invalid_taste_profile_score",
            "Taste profile scores must be integers from 1 to 5.",
            3,
        )
    if last == "rating":
        return (
            "invalid_cocktail_rating",
            "rating must be from 0 to 10 in 0.5 increments.",
            8.5,
        )
    if last == "repeat_intent":
        return (
            "invalid_repeat_intent",
            "repeat_intent must be definitely, maybe, or no.",
            "maybe",
        )
    if last in {"recipe_ref", "parent_recipe_ref"}:
        return (
            "invalid_recipe_reference",
            "Recipe references must use record:<id>.",
            "record:<recipe-id>",
        )
    if last == "recipe_version":
        return "invalid_recipe_version", "recipe_version must be an existing positive version.", 1
    if error_type == "extra_forbidden":
        return "invalid_cocktail_schema", "Unknown cocktail payload field.", None
    return "invalid_cocktail_schema", "Cocktail payload failed validation.", None


def cocktail_validation_issue(
    schema_name: str,
    error: ValidationError,
) -> RecordSchemaValidationIssue:
    first = error.errors(include_url=False)[0]
    location = tuple(first.get("loc") or ())
    context = first.get("ctx")
    context_mapping = context if isinstance(context, dict) else {}
    context_field = context_mapping.get("field")
    if isinstance(context_field, str) and (not location or str(location[-1]) != context_field):
        location = (*location, context_field)
    error_type = str(first.get("type") or "")
    code, message, example = _error_code_for_location(schema_name, location, error_type)
    if error_type in COCKTAIL_ERROR_CODES:
        message = str(first.get("msg") or message)
        example = context_mapping.get("example", example)
    return RecordSchemaValidationIssue(
        code=code,
        field=payload_field_path(location),
        message=message,
        received_value=scalar_error_value(first.get("input")),
        example=example,
    )
