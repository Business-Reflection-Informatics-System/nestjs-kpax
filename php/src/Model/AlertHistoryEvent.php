<?php

declare(strict_types=1);

namespace BizReflex\Kpax\Model;

/** One technical alert occurrence window. */
final class AlertHistoryEvent
{
    /** @param array<string, mixed> $raw */
    public function __construct(
        public readonly ?string $value,
        public readonly ?string $firstTimeSeenOn,
        public readonly ?string $lastTimeSeenOn,
        public readonly ?string $eventEndDate,
        public readonly ?int $occurrences,
        public readonly array $raw,
    ) {
    }

    /** @param array<string, mixed> $raw */
    public static function fromArray(array $raw): self
    {
        return new self(
            Convert::str($raw['value'] ?? null),
            Convert::str($raw['first_time_seen_on'] ?? null),
            Convert::str($raw['last_time_seen_on'] ?? null),
            Convert::str($raw['event_end_date'] ?? null),
            Convert::int($raw['occurrences'] ?? null),
            $raw,
        );
    }
}
