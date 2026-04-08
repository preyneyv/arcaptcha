from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

EARLIEST_TIMEZONE = timezone(timedelta(hours=14))


class EditionDateValidationError(ValueError):
    pass


def current_anchor_date(now: datetime | None = None) -> date:
    current_time = (
        now.astimezone(EARLIEST_TIMEZONE) if now else datetime.now(EARLIEST_TIMEZONE)
    )
    return current_time.date()


def playable_edition_dates(
    season_start: date,
    now: datetime | None = None,
) -> tuple[date, ...]:
    anchor_date = current_anchor_date(now)
    if anchor_date < season_start:
        anchor_date = season_start

    editions = [anchor_date]
    previous_date = anchor_date - timedelta(days=1)
    if previous_date >= season_start:
        editions.append(previous_date)

    return tuple(editions)


def resolve_edition_date(
    raw: object,
    *,
    season_start: date,
    now: datetime | None = None,
) -> date:
    allowed_dates = playable_edition_dates(season_start, now)
    if raw is None or raw == "":
        return allowed_dates[0]

    if not isinstance(raw, str):
        raise EditionDateValidationError("edition_date must be an ISO date string")

    try:
        requested_date = date.fromisoformat(raw)
    except ValueError as error:
        raise EditionDateValidationError(
            "edition_date must be an ISO date string"
        ) from error

    if requested_date not in allowed_dates:
        formatted_dates = ", ".join(
            allowed_date.isoformat() for allowed_date in allowed_dates
        )
        raise EditionDateValidationError(
            f"edition_date must be one of: {formatted_dates}"
        )

    return requested_date
