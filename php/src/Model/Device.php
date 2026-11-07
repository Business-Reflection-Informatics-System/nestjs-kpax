<?php

declare(strict_types=1);

namespace BizReflex\Kpax\Model;

/** Core device fields. A full device's meters, supplies, alerts, … are in $raw. */
final class Device
{
    /** @param array<string, mixed> $raw */
    public function __construct(
        public readonly ?int $id,
        public readonly ?string $serialNumber,
        public readonly ?string $serialNumberOrigin,
        public readonly ?string $manufacturer,
        public readonly ?string $manufacturerOrigin,
        public readonly ?string $model,
        public readonly ?string $modelOrigin,
        public readonly ?string $parentType,
        public readonly ?int $parentId,
        public readonly ?int $profileId,
        public readonly ?int $agentId,
        public readonly ?string $macAddress,
        public readonly ?string $typology,
        public readonly ?string $lastCheck,
        public readonly ?string $createdAt,
        public readonly array $raw,
    ) {
    }

    /** @param array<string, mixed> $raw */
    public static function fromArray(array $raw): self
    {
        return new self(
            Convert::int($raw['id'] ?? null),
            Convert::str($raw['serial_number'] ?? null),
            Convert::str($raw['serial_number_origin'] ?? null),
            Convert::str($raw['manufacturer'] ?? null),
            Convert::str($raw['manufacturer_origin'] ?? null),
            Convert::str($raw['model'] ?? null),
            Convert::str($raw['model_origin'] ?? null),
            Convert::str($raw['parent_type'] ?? null),
            Convert::int($raw['parent_id'] ?? null),
            Convert::int($raw['profile_id'] ?? null),
            Convert::int($raw['agent_id'] ?? null),
            Convert::str($raw['mac_address'] ?? null),
            Convert::str($raw['typology'] ?? null),
            Convert::str($raw['last_check'] ?? null),
            Convert::str($raw['created_at'] ?? null),
            $raw,
        );
    }
}
