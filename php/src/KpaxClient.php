<?php

declare(strict_types=1);

namespace BizReflex\Kpax;

use BizReflex\Kpax\Exception\KpaxApiException;
use BizReflex\Kpax\Exception\KpaxAuthException;
use BizReflex\Kpax\Exception\KpaxConfigurationException;
use BizReflex\Kpax\Exception\TransportException;
use BizReflex\Kpax\Model\Account;
use BizReflex\Kpax\Model\AlertHistoryEvent;
use BizReflex\Kpax\Model\ConnectionTestResult;
use BizReflex\Kpax\Model\Device;
use BizReflex\Kpax\Model\Page;
use BizReflex\Kpax\Model\PaginationMeta;
use BizReflex\Kpax\Model\RateLimit;
use BizReflex\Kpax\Model\ServerStatus;
use BizReflex\Kpax\Transport\CurlTransport;
use BizReflex\Kpax\Transport\HttpRequest;
use BizReflex\Kpax\Transport\HttpResponse;
use BizReflex\Kpax\Transport\Transport;

/**
 * Client for one KPAX instance (KPAX API v1). Behaviour ids (Bxx) refer to
 * docs/client-behavior.md in the repository.
 */
final class KpaxClient
{
    public const DEFAULT_SCOPES = [
        'accounts:read', 'agents:read', 'devices:read', 'hierarchy-elements:read',
        'dynamic-groups:read', 'profiles:read', 'rules:read', 'labels:read', 'server:read',
    ];

    private const IDEMPOTENT = ['GET' => true, 'PUT' => true, 'DELETE' => true];

    public readonly string $host;
    public readonly string $clientId;
    /** @var list<string> */
    public readonly array $scopes;
    private readonly string $clientSecret;
    private readonly Transport $transport;
    /** @var callable(float): void */
    private $sleep;
    /** @var callable(): float */
    private $clock;

    private ?string $token = null;
    private float $tokenExpiresAt = 0.0;
    private float $blockedUntil = 0.0;
    private ?RateLimit $lastRateLimit = null;

    /**
     * @param list<string>|null          $scopes defaults to DEFAULT_SCOPES
     * @param (callable(float): void)|null $sleep  seconds; for tests
     * @param (callable(): float)|null     $clock  unix seconds; for tests
     *
     * @throws KpaxConfigurationException invalid host or missing credentials (B10)
     */
    public function __construct(
        string $host,
        string $clientId,
        string $clientSecret,
        ?array $scopes = null,
        private readonly float $timeout = 30.0,
        private readonly int $maxRetries = 4,
        private readonly float $baseDelay = 0.5,
        private readonly float $maxDelay = 60.0,
        private readonly float $tokenRefreshSkew = 60.0,
        ?Transport $transport = null,
        ?callable $sleep = null,
        ?callable $clock = null,
    ) {
        $this->host = self::normalizeHost($host);
        $this->clientId = trim($clientId);
        $this->clientSecret = trim($clientSecret);
        if ($this->clientId === '' || $this->clientSecret === '') {
            throw new KpaxConfigurationException("KPAX connection for {$this->host} is missing clientId or clientSecret");
        }
        $this->scopes = $scopes !== null && $scopes !== [] ? array_values($scopes) : self::DEFAULT_SCOPES;
        $this->transport = $transport ?? new CurlTransport();
        $this->sleep = $sleep ?? static function (float $s): void {
            if ($s > 0) {
                usleep((int) round($s * 1_000_000));
            }
        };
        $this->clock = $clock ?? static fn (): float => microtime(true);
    }

    /** Last X-RateLimit-* values seen (B08). */
    public function lastRateLimit(): ?RateLimit
    {
        return $this->lastRateLimit;
    }

    // ----------------------------------------------------------------- server / hierarchy

    public function serverStatus(): ServerStatus
    {
        return ServerStatus::fromArray(self::asArray($this->request('GET', '/server/status')));
    }

    /**
     * Accounts, agents, devices and dynamic groups under a container (default: the client's own level).
     *
     * @return array<string, mixed>
     */
    public function hierarchy(?string $objectType = null, ?int $objectId = null): array
    {
        $query = $objectType === null ? [] : ['object_type' => $objectType, 'object_id' => $objectId];

        return self::asArray($this->request('GET', '/hierarchy-elements', query: $query));
    }

    // --------------------------------------------------------------------------- accounts

    /** @return Page<Account> */
    public function listAccounts(?int $parentId = null, ?bool $withChildren = null, ?int $page = null): Page
    {
        $query = ['page' => $page];
        if ($parentId !== null) {
            $query += ['parent_type' => 'account', 'parent_id' => $parentId, 'with_children' => $withChildren];
        }

        return self::page($this->request('GET', '/accounts', query: $query), Account::fromArray(...));
    }

    /** @return \Generator<int, Account> every account across pages */
    public function iterAccounts(?int $parentId = null, ?bool $withChildren = null): \Generator
    {
        return self::paginate(fn (int $p) => $this->listAccounts($parentId, $withChildren, $p));
    }

    public function getAccount(int $accountId): Account
    {
        return Account::fromArray(self::asArray($this->request('GET', '/accounts/{id}', ['id' => $accountId])));
    }

    // ---------------------------------------------------------------------------- devices

    /**
     * One page of devices. $perPage (≤1000) only applies to the core schema (B12).
     *
     * @return Page<Device>
     */
    public function listDevices(
        ?string $parentType = null,
        ?int $parentId = null,
        ?bool $withChildren = null,
        string $schema = 'core',
        ?int $page = null,
        ?int $perPage = null,
        ?string $sort = null,
    ): Page {
        $query = self::scope($parentType, $parentId, $withChildren) + [
            'schema' => $schema,
            'sort' => $sort,
            'page' => $page,
            'per_page' => $schema === 'core' ? $perPage : null,
        ];

        return self::page($this->request('GET', '/devices', query: $query), Device::fromArray(...));
    }

    /** @return \Generator<int, Device> every device; 1000 per page on the core schema (B12) */
    public function iterDevices(
        ?string $parentType = null,
        ?int $parentId = null,
        ?bool $withChildren = null,
        string $schema = 'core',
        ?int $perPage = null,
        ?string $sort = null,
    ): \Generator {
        if ($perPage === null && $schema === 'core') {
            $perPage = 1000;
        }

        return self::paginate(fn (int $p) => $this->listDevices($parentType, $parentId, $withChildren, $schema, $p, $perPage, $sort));
    }

    /** Full device; meters, supplies, alerts, … are in ->raw. */
    public function getDevice(int $deviceId): Device
    {
        return Device::fromArray(self::asArray($this->request('GET', '/devices/{id}', ['id' => $deviceId])));
    }

    /**
     * Partial serial search (≥5 characters), all pages.
     *
     * @return list<Device>
     */
    public function searchDevicesBySerial(string $serial, ?string $parentType = null, ?int $parentId = null): array
    {
        $s = trim($serial);
        if (strlen($s) < 5) {
            throw new \InvalidArgumentException('KPAX serial-number search needs at least 5 characters');
        }

        return iterator_to_array(self::paginate(fn (int $p) => self::page(
            $this->request('GET', '/devices/search-by-serial-number', query: ['serial_number' => $s] + self::scope($parentType, $parentId, null) + ['page' => $p]),
            Device::fromArray(...),
        )), false);
    }

    /**
     * Exact, case-insensitive match on the effective or original serial (B13). Null when
     * nothing matches; KpaxApiException with status 409 when several devices match.
     */
    public function findDeviceBySerial(string $serial, ?string $parentType = null, ?int $parentId = null): ?Device
    {
        $want = strtoupper(trim($serial));
        $hits = array_values(array_filter(
            $this->searchDevicesBySerial($want, $parentType, $parentId),
            static fn (Device $d): bool => ($d->serialNumber !== null && strtoupper(trim($d->serialNumber)) === $want)
                || ($d->serialNumberOrigin !== null && strtoupper(trim($d->serialNumberOrigin)) === $want),
        ));
        if (count($hits) > 1) {
            throw new KpaxApiException(409, 'GET', '/devices/search-by-serial-number', ['matches' => array_map(static fn (Device $d) => $d->id, $hits)], sprintf('Serial %s matches %d KPAX devices', $want, count($hits)));
        }

        return $hits[0] ?? null;
    }

    /**
     * POST /devices/search: bulk read of chosen attributes across a fleet (B14).
     *
     * @param list<array{namespace: string, name: string}>|null                                     $attributes
     * @param list<array{namespace: string, name: string, operator: string, value: string}>|null    $filters
     * @param list<int>|null                                                                        $profileIds
     *
     * @return Page<array<string, mixed>>
     */
    public function searchDevices(
        ?string $parentType = null,
        ?int $parentId = null,
        ?bool $withChildren = null,
        ?array $attributes = null,
        ?array $filters = null,
        ?bool $attributesWithLastCheck = null,
        ?array $profileIds = null,
        ?string $sort = null,
        ?int $page = null,
        ?int $perPage = null,
    ): Page {
        $form = [];
        if ($parentType !== null) {
            $form['parent_type'] = $parentType;
            $form['parent_id'] = (string) $parentId;
            if ($withChildren !== null) {
                $form['with_children'] = $withChildren ? '1' : '0';
            }
        }
        if ($attributes) {
            $form['attributes'] = json_encode(array_values($attributes), JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
        }
        if ($filters) {
            $form['filters'] = json_encode(array_values($filters), JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
        }
        if ($attributesWithLastCheck !== null) {
            $form['attributes_with_last_check'] = $attributesWithLastCheck ? '1' : '0';
        }
        if ($profileIds) {
            $form['profile_id'] = implode(',', array_map('strval', $profileIds));
        }
        if ($sort !== null) {
            $form['sort'] = $sort;
        }
        if ($page !== null) {
            $form['page'] = (string) $page;
        }
        if ($perPage !== null) {
            $form['per_page'] = (string) $perPage;
        }

        return self::page($this->request('POST', '/devices/search', form: $form), static fn (array $row): array => $row);
    }

    /**
     * Every page of searchDevices(); takes the same named arguments except $page.
     *
     * @return \Generator<int, array<string, mixed>>
     */
    public function iterDeviceSearch(mixed ...$args): \Generator
    {
        unset($args['page']);

        return self::paginate(fn (int $p) => $this->searchDevices(...$args, page: $p));
    }

    /**
     * {volumeName: {date: count}}. Dates are YYYY-MM-DD, UTC (B15).
     *
     * @return array<string, array<string, int|float>>
     */
    public function getDeviceVolumes(int $deviceId, string $startDate, string $endDate, string $interval = 'daily', ?string $volumeName = null): array
    {
        return self::asArray($this->request('GET', '/devices/{id}/volumes', ['id' => $deviceId], [
            'interval' => $interval,
            'start_date' => $startDate,
            'end_date' => $endDate,
            'volume_name' => $volumeName,
        ]));
    }

    /** @return list<array<string, mixed>> daily snapshots */
    public function getDeviceHistory(int $deviceId, ?string $startDate = null, ?string $endDate = null, ?string $sort = null): array
    {
        return self::asList($this->request('GET', '/devices/{id}/history', ['id' => $deviceId], ['start_date' => $startDate, 'end_date' => $endDate, 'sort' => $sort]));
    }

    /** @return list<array<string, mixed>> */
    public function getDeviceAttributeHistory(int $deviceId, string $namespace, string $name, ?string $startDate = null, ?string $endDate = null, ?string $sort = null): array
    {
        return self::asList($this->request('GET', '/devices/{id}/attributes/history', ['id' => $deviceId], [
            'namespace' => $namespace, 'name' => $name, 'start_date' => $startDate, 'end_date' => $endDate, 'sort' => $sort,
        ]));
    }

    /** @return list<array<string, mixed>> toner cycles for black, cyan, magenta or yellow */
    public function getSupplyCycles(int $deviceId, string $cartridge, ?int $nbCycles = null): array
    {
        return self::asList($this->request('GET', '/devices/{id}/supply-cycles', ['id' => $deviceId], ['cartridge' => $cartridge, 'nb_cycles' => $nbCycles]));
    }

    /** @return list<AlertHistoryEvent> all pages */
    public function getTechnicalAlertHistory(int $deviceId, ?string $startDate = null, ?string $endDate = null, ?string $sort = null): array
    {
        return iterator_to_array(self::paginate(fn (int $p) => self::page(
            $this->request('GET', '/devices/{id}/technical-status-events/history', ['id' => $deviceId], ['start_date' => $startDate, 'end_date' => $endDate, 'sort' => $sort, 'page' => $p]),
            AlertHistoryEvent::fromArray(...),
        )), false);
    }

    public function listDeviceAttributes(?string $filter = null, ?string $locale = null): mixed
    {
        return $this->request('GET', '/devices/attributes', query: ['filter' => $filter, 'locale' => $locale]);
    }

    public function listProfiles(): mixed
    {
        return $this->request('GET', '/profiles');
    }

    // ------------------------------------------------------------------- connection test

    /** Token + GET /server/status. Never throws (B17). */
    public function testConnection(): ConnectionTestResult
    {
        $start = ($this->clock)();
        try {
            $server = $this->serverStatus();

            return new ConnectionTestResult(true, $this->msSince($start), server: $server);
        } catch (KpaxAuthException $e) {
            return new ConnectionTestResult(false, $this->msSince($start), 'auth', $e->status, $e->getMessage());
        } catch (KpaxApiException $e) {
            return new ConnectionTestResult(false, $this->msSince($start), 'api', $e->status, $e->getMessage());
        } catch (\Throwable $e) {
            return new ConnectionTestResult(false, $this->msSince($start), 'api', null, $e->getMessage());
        }
    }

    /**
     * Like testConnection(), also reporting invalid settings as stage "config".
     *
     * @param array<string, mixed> $options extra constructor arguments by name
     */
    public static function testCredentials(string $host, string $clientId, string $clientSecret, array $options = []): ConnectionTestResult
    {
        try {
            $client = new self($host, $clientId, $clientSecret, ...$options);
        } catch (KpaxConfigurationException $e) {
            return new ConnectionTestResult(false, 0, 'config', null, $e->getMessage());
        }

        return $client->testConnection();
    }

    // ------------------------------------------------------------------------- transport

    /**
     * Calls any KPAX v1 endpoint (path relative to /api/v1, with {name} placeholders) with
     * auth, retries and rate-limit handling. Returns the decoded JSON body (null when empty).
     *
     * @param array<string, scalar|null>  $pathParams
     * @param array<string, mixed>        $query      nulls omitted, bools as true/false (B16)
     * @param array<string, string>|null  $form       form-encoded body (takes precedence over $json)
     */
    public function request(string $method, string $path, array $pathParams = [], array $query = [], mixed $json = null, ?array $form = null): mixed
    {
        $method = strtoupper($method);
        $resolved = self::interpolate($path, $pathParams);
        $res = $this->send($method, $resolved, $query, $json, $form);
        $body = self::decode($res->body);
        if ($res->status < 200 || $res->status >= 300) {
            throw new KpaxApiException($res->status, $method, $resolved, $body);
        }

        return $body;
    }

    /**
     * @param array<string, mixed>       $query
     * @param array<string, string>|null $form
     */
    private function send(string $method, string $path, array $query, mixed $json, ?array $form): HttpResponse
    {
        $url = $this->host . '/api/v1' . $path . self::encodeQuery($query);
        $headers = ['Accept' => 'application/json'];
        $body = null;
        if ($form !== null) {
            $headers['Content-Type'] = 'application/x-www-form-urlencoded';
            $body = http_build_query($form, '', '&', PHP_QUERY_RFC3986);
        } elseif ($json !== null) {
            $headers['Content-Type'] = 'application/json';
            $body = json_encode($json, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
        }

        $attempt = 0;
        $refreshed = false;
        while (true) {
            $wait = $this->blockedUntil - ($this->clock)();
            if ($wait > 0) {
                ($this->sleep)(min($wait, $this->maxDelay));
            }
            $headers['Authorization'] = 'Bearer ' . $this->token();

            try {
                $res = $this->transport->send(new HttpRequest($method, $url, $headers, $body, $this->timeout));
            } catch (TransportException $e) {
                if (isset(self::IDEMPOTENT[$method]) && $attempt < $this->maxRetries) { // B07
                    ($this->sleep)($this->backoff($attempt));
                    $attempt++;
                    continue;
                }
                throw new KpaxApiException(0, $method, $path, ['message' => $e->getMessage()], previous: $e);
            }

            $this->trackRateLimit($res);

            if ($res->status === 401 && !$refreshed) { // B04
                $refreshed = true;
                $this->token = null;
                $this->tokenExpiresAt = 0.0;
                continue;
            }
            if ($res->status === 429 && $attempt < $this->maxRetries) { // B06
                $delay = min($this->retryAfter($res) ?? $this->backoff($attempt), $this->maxDelay);
                $attempt++;
                $this->blockedUntil = max($this->blockedUntil, ($this->clock)() + $delay);
                ($this->sleep)($delay);
                continue;
            }
            if ($res->status >= 500 && isset(self::IDEMPOTENT[$method]) && $attempt < $this->maxRetries) { // B07
                ($this->sleep)($this->backoff($attempt));
                $attempt++;
                continue;
            }

            return $res;
        }
    }

    /** Forget the cached token (e.g. after rotating credentials elsewhere). */
    public function resetToken(): void
    {
        $this->token = null;
        $this->tokenExpiresAt = 0.0;
    }

    private function token(): string
    {
        if ($this->token !== null && ($this->clock)() < $this->tokenExpiresAt) { // B03
            return $this->token;
        }
        $form = http_build_query([
            'grant_type' => 'client_credentials',
            'client_id' => $this->clientId,
            'client_secret' => $this->clientSecret,
            'scope' => implode(' ', $this->scopes),
        ], '', '&', PHP_QUERY_RFC3986);
        try {
            $res = $this->transport->send(new HttpRequest('POST', $this->host . '/oauth/token', [
                'Accept' => 'application/json',
                'Content-Type' => 'application/x-www-form-urlencoded',
            ], $form, $this->timeout));
        } catch (TransportException $e) {
            throw new KpaxAuthException(0, $this->host, ['message' => $e->getMessage()], $e);
        }
        $body = self::decode($res->body);
        if ($res->status < 200 || $res->status >= 300) { // B05
            throw new KpaxAuthException($res->status, $this->host, $body);
        }
        if (!is_array($body) || !isset($body['access_token']) || !is_string($body['access_token'])) {
            throw new KpaxAuthException($res->status, $this->host, ['message' => 'Token response did not include access_token']);
        }
        $ttl = isset($body['expires_in']) && is_numeric($body['expires_in']) && $body['expires_in'] > 0 ? (float) $body['expires_in'] : 3600.0;
        $this->token = $body['access_token'];
        $this->tokenExpiresAt = ($this->clock)() + max($ttl - $this->tokenRefreshSkew, 0.0);

        return $this->token;
    }

    private function trackRateLimit(HttpResponse $res): void
    {
        $limit = self::intHeader($res, 'x-ratelimit-limit');
        $remaining = self::intHeader($res, 'x-ratelimit-remaining');
        $reset = self::intHeader($res, 'x-ratelimit-reset');
        if ($limit === null && $remaining === null && $reset === null) {
            return;
        }
        $this->lastRateLimit = new RateLimit($limit, $remaining, $reset);
        if ($remaining === 0 && $reset !== null && $reset > 0) { // B08
            $this->blockedUntil = max($this->blockedUntil, (float) $reset);
        }
    }

    private function retryAfter(HttpResponse $res): ?float
    {
        $ra = $res->header('retry-after');
        if ($ra !== null && $ra !== '') {
            if (is_numeric($ra)) {
                return max((float) $ra, 0.0);
            }
            $ts = strtotime($ra);
            if ($ts !== false) {
                return max($ts - ($this->clock)(), 0.0);
            }
        }
        $reset = self::intHeader($res, 'x-ratelimit-reset');

        return $reset === null ? null : max($reset - ($this->clock)(), 0.0);
    }

    private function backoff(int $attempt): float
    {
        $exp = $this->baseDelay * (2 ** $attempt);

        return min($exp / 2 + (mt_rand() / mt_getrandmax()) * ($exp / 2), $this->maxDelay);
    }

    private function msSince(float $start): int
    {
        return (int) round((($this->clock)() - $start) * 1000);
    }

    // --------------------------------------------------------------------------- helpers

    /**
     * Walks KPAX pagination (B11).
     *
     * @template T
     *
     * @param callable(int): Page<T> $fetchPage
     *
     * @return \Generator<int, T>
     */
    public static function paginate(callable $fetchPage, int $startPage = 1, ?int $maxPages = null): \Generator
    {
        $page = $startPage;
        $fetched = 0;
        while (true) {
            $res = $fetchPage($page);
            foreach ($res->data as $item) {
                yield $item;
            }
            $fetched++;
            if ($res->data === [] || $res->meta === null) {
                return;
            }
            $current = $res->meta->currentPage ?? $page;
            $last = $res->meta->lastPage ?? $current;
            if ($current >= $last || ($maxPages !== null && $fetched >= $maxPages)) {
                return;
            }
            $page = $current + 1;
        }
    }

    /**
     * @template T
     *
     * @param callable(array<string, mixed>): T $convert
     *
     * @return Page<T>
     */
    private static function page(mixed $body, callable $convert): Page
    {
        if (!is_array($body)) {
            return new Page([]);
        }
        $data = [];
        foreach (is_array($body['data'] ?? null) ? $body['data'] : [] as $item) {
            if (is_array($item)) {
                $data[] = $convert($item);
            }
        }

        return new Page($data, PaginationMeta::fromArray(is_array($body['meta'] ?? null) ? $body['meta'] : null));
    }

    /** @return array<string, mixed> */
    private static function scope(?string $parentType, ?int $parentId, ?bool $withChildren): array
    {
        if ($parentType === null) {
            return [];
        }

        return [
            'parent_type' => $parentType,
            'parent_id' => $parentId,
            'with_children' => $parentType === 'account' ? $withChildren : null,
        ];
    }

    private static function normalizeHost(string $host): string
    {
        $h = rtrim(trim($host), '/');
        if (str_ends_with(strtolower($h), '/api/v1')) {
            $h = rtrim(substr($h, 0, -strlen('/api/v1')), '/');
        }
        $scheme = parse_url($h, PHP_URL_SCHEME);
        $hostPart = parse_url($h, PHP_URL_HOST);
        if (!in_array($scheme, ['http', 'https'], true) || !is_string($hostPart) || $hostPart === '' || str_contains($h, ' ')) {
            throw new KpaxConfigurationException(sprintf('KPAX host is not a valid http(s) URL: "%s"', $h));
        }

        return $h;
    }

    /** @param array<string, scalar|null> $params */
    private static function interpolate(string $path, array $params): string
    {
        return (string) preg_replace_callback('/\{(\w+)\}/', static function (array $m) use ($path, $params): string {
            $v = $params[$m[1]] ?? null;
            if ($v === null || $v === '') {
                throw new \InvalidArgumentException(sprintf('Missing path parameter "%s" for %s', $m[1], $path));
            }

            return rawurlencode((string) $v);
        }, $path);
    }

    /** @param array<string, mixed> $query */
    private static function encodeQuery(array $query): string
    {
        $q = [];
        foreach ($query as $k => $v) {
            if ($v === null) {
                continue;
            }
            $q[$k] = is_bool($v) ? ($v ? 'true' : 'false') : $v;
        }

        return $q === [] ? '' : '?' . http_build_query($q, '', '&', PHP_QUERY_RFC3986);
    }

    private static function decode(string $body): mixed
    {
        if (trim($body) === '') {
            return null;
        }
        try {
            return json_decode($body, true, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            return $body;
        }
    }

    /** @return array<string, mixed> */
    private static function asArray(mixed $v): array
    {
        return is_array($v) ? $v : [];
    }

    /** @return list<array<string, mixed>> */
    private static function asList(mixed $v): array
    {
        return is_array($v) ? array_values(array_filter($v, 'is_array')) : [];
    }

    private static function intHeader(HttpResponse $res, string $name): ?int
    {
        $v = $res->header($name);

        return $v !== null && is_numeric($v) ? (int) $v : null;
    }
}
