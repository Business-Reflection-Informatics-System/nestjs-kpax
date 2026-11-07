<?php

declare(strict_types=1);

namespace BizReflex\Kpax\Model;

/** Payload of GET /server/status. */
final class ServerStatus
{
    /** @param array<string, mixed> $raw */
    public function __construct(
        public readonly ?string $version,
        public readonly ?string $timezoneServer,
        public readonly ?string $dateServer,
        public readonly array $raw,
    ) {
    }

    /** @param array<string, mixed> $raw */
    public static function fromArray(array $raw): self
    {
        return new self(
            Convert::str($raw['version'] ?? null),
            Convert::str($raw['timezone_server'] ?? null),
            Convert::str($raw['date_server'] ?? null),
            $raw,
        );
    }
}
