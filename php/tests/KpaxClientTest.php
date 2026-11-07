<?php

declare(strict_types=1);

namespace BizReflex\Kpax\Tests;

use BizReflex\Kpax\Exception\KpaxApiException;
use BizReflex\Kpax\Exception\KpaxAuthException;
use BizReflex\Kpax\Exception\KpaxConfigurationException;
use BizReflex\Kpax\KpaxClient;
use BizReflex\Kpax\Model\Account;
use BizReflex\Kpax\Model\Device;
use BizReflex\Kpax\Model\RateLimit;
use BizReflex\Kpax\Transport\HttpRequest;

final class KpaxClientTest
{
    private MockKpax $mock;
    private FakeClock $clock;

    public function __construct()
    {
        $this->mock = new MockKpax();
        $this->clock = new FakeClock();
    }

    private function client(): KpaxClient
    {
        return new KpaxClient(
            'https://acme.kpax.cloud/',
            'cid',
            'secret-1',
            baseDelay: 0.001,
            transport: $this->mock,
            sleep: $this->clock->sleep(...),
            clock: $this->clock->time(...),
        );
    }

    /** B01 B02 */
    public function testB01ClientCredentialsAndBearer(): void
    {
        Assert::same('3.20.0', $this->client()->serverStatus()->version);
        $f = $this->mock->tokenRequests[0];
        Assert::same('client_credentials', $f['grant_type']);
        Assert::same('cid', $f['client_id']);
        Assert::same('secret-1', $f['client_secret']);
        Assert::same(implode(' ', KpaxClient::DEFAULT_SCOPES), $f['scope']);
        Assert::same('https://acme.kpax.cloud/api/v1/server/status', $this->mock->calls[0]->url);
        Assert::same('Bearer tok-1', $this->mock->calls[0]->headers['Authorization']);
        Assert::same('application/json', $this->mock->calls[0]->headers['Accept']);
    }

    /** B03 */
    public function testB03TokenCachedAndRefreshedBeforeExpiry(): void
    {
        $c = $this->client();
        $c->serverStatus();
        $c->serverStatus();
        Assert::same(1, count($this->mock->tokenRequests));
        $this->clock->now += 3600 - 60 + 1;
        $c->serverStatus();
        Assert::same(2, count($this->mock->tokenRequests));
    }

    /** B04 */
    public function testB04RefreshOnceOn401ThenSurface(): void
    {
        $c = $this->client();
        $this->mock->handler = static fn (HttpRequest $r, int $n) => $n === 1
            ? json(['message' => 'Unauthenticated.'], 401)
            : json(fixture('server-status.json'));
        $c->serverStatus();
        Assert::same('Bearer tok-1', $this->mock->calls[0]->headers['Authorization']);
        Assert::same('Bearer tok-2', $this->mock->calls[1]->headers['Authorization']);

        $this->mock->handler = static fn () => json(['message' => 'Invalid scope(s) provided.'], 401);
        $e = Assert::throws(KpaxApiException::class, static fn () => $c->serverStatus());
        Assert::true($e->isUnauthorized() && str_contains($e->getMessage(), 'Invalid scope'), '401 with KPAX message');
    }

    /** B05 */
    public function testB05TokenEndpointRefusal(): void
    {
        $this->mock->tokenHandler = static fn () => json(['error' => 'invalid_client'], 401);
        $e = Assert::throws(KpaxAuthException::class, fn () => $this->client()->serverStatus());
        Assert::same(401, $e->status);
        Assert::true(str_contains($e->getMessage(), 'invalid_client'), 'message has invalid_client');
    }

    /** B06 */
    public function testB06RetryAfterOn429ForAnyMethod(): void
    {
        $this->mock->handler = static fn (HttpRequest $r, int $n) => $n === 1
            ? json([], 429, ['Retry-After' => '7'])
            : json(['data' => []]);
        $this->client()->searchDevices();
        Assert::same(2, count($this->mock->calls));
        Assert::same(7.0, $this->clock->sleeps[0]);
    }

    /** B07 */
    public function testB07FiveHundredsRetriedForGetNotPost(): void
    {
        $c = $this->client();
        $this->mock->handler = static fn (HttpRequest $r, int $n) => $n < 3 ? json([], 503) : json(fixture('server-status.json'));
        $c->serverStatus();
        Assert::same(3, count($this->mock->calls));

        $this->mock->calls = [];
        $this->mock->handler = static fn () => json(['message' => 'boom'], 502);
        $e = Assert::throws(KpaxApiException::class, static fn () => $c->searchDevices());
        Assert::same(502, $e->status);
        Assert::same(1, count($this->mock->calls));
    }

    /** B07 */
    public function testB07NetworkErrorRetriedForGet(): void
    {
        $first = true;
        $this->mock->fault = static function () use (&$first) {
            if ($first) {
                $first = false;

                return transportError('connection reset');
            }

            return null;
        };
        Assert::same('3.20.0', $this->client()->serverStatus()->version);
        Assert::same(1, count($this->clock->sleeps));
    }

    /** B07 B09 */
    public function testB09FourHundredsNotRetriedAndErrorDetails(): void
    {
        $this->mock->handler = static fn () => json(['message' => 'This action is unauthorized.'], 403);
        $e = Assert::throws(KpaxApiException::class, fn () => $this->client()->getDevice(42));
        Assert::true($e->isForbidden(), 'forbidden');
        Assert::same('GET', $e->method);
        Assert::same('/devices/42', $e->path);
        Assert::same(['message' => 'This action is unauthorized.'], $e->body);
        Assert::same(1, count($this->mock->calls));
    }

    /** B08 */
    public function testB08RateLimitExhaustedHoldsNextRequest(): void
    {
        $c = $this->client();
        $reset = (int) $this->clock->now + 5;
        $this->mock->handler = static fn () => json(fixture('server-status.json'), 200, [
            'X-RateLimit-Limit' => '60', 'X-RateLimit-Remaining' => '0', 'X-RateLimit-Reset' => (string) $reset,
        ]);
        $c->serverStatus();
        Assert::true($c->lastRateLimit() == new RateLimit(60, 0, $reset), 'rate limit recorded');
        $c->serverStatus();
        Assert::same([5.0], $this->clock->sleeps);
    }

    /** B10 */
    public function testB10ConfigurationValidation(): void
    {
        foreach ([['not a url', 'a', 'b'], ['ftp://x.kpax.cloud', 'a', 'b'], ['https://x.kpax.cloud', 'a', ' '], ['https://x.kpax.cloud', '', 'b']] as [$h, $id, $s]) {
            Assert::throws(KpaxConfigurationException::class, static fn () => new KpaxClient($h, $id, $s, transport: new MockKpax()));
        }
        Assert::same('https://acme.kpax.cloud', (new KpaxClient(' https://acme.kpax.cloud/api/v1/ ', 'a', 'b', transport: new MockKpax()))->host);
    }

    /** B11 B12 B18 */
    public function testB11IterateDevicesAllPages(): void
    {
        $this->mock->handler = static fn (HttpRequest $r) => json(fixture('devices-page-' . query($r)['page'] . '.json'));
        $devices = iterator_to_array($this->client()->iterDevices(parentType: 'account', parentId: 12, withChildren: true), false);
        Assert::same([1, 2, 3, 4], array_map(static fn (Device $d) => $d->id, $devices));
        Assert::same('TASKalfa 2554ci', $devices[0]->model);
        Assert::same(
            ['parent_type' => 'account', 'parent_id' => '12', 'with_children' => 'true', 'schema' => 'core', 'page' => '1', 'per_page' => '1000'],
            query($this->mock->calls[0]),
        );
    }

    /** B12 */
    public function testB12PerPageOnlyWithCoreSchema(): void
    {
        $this->mock->handler = static fn () => json(['data' => []]);
        $this->client()->listDevices(schema: 'full', perPage: 500);
        Assert::true(!array_key_exists('per_page', query($this->mock->calls[0])), 'no per_page');
    }

    /** B11 B18 */
    public function testB11IterateAccounts(): void
    {
        $this->mock->handler = static fn (HttpRequest $r) => json(fixture('accounts-page-' . query($r)['page'] . '.json'));
        $accounts = iterator_to_array($this->client()->iterAccounts(), false);
        Assert::same([10, 11, 12], array_map(static fn (Account $a) => $a->id, $accounts));
        Assert::same(1, $accounts[1]->parentId);
    }

    /** B13 */
    public function testB13FindDeviceBySerial(): void
    {
        $c = $this->client();
        $this->mock->handler = static fn () => json(fixture('serial-search.json'));
        Assert::same(7, $c->findDeviceBySerial(' abcd123456789 ')?->id);
        Assert::same('ABCD123456789', query($this->mock->calls[0])['serial_number']);
        Assert::same(9, $c->findDeviceBySerial('xyz987654321')?->id);
        Assert::same(null, $c->findDeviceBySerial('ABCD12345678'));
        Assert::throws(\InvalidArgumentException::class, static fn () => $c->findDeviceBySerial('ABC'));
    }

    /** B13 */
    public function testB13AmbiguousSerial(): void
    {
        $dup = fixture('serial-search.json');
        $dup['data'][1]['serial_number'] = 'ABCD123456789';
        $this->mock->handler = static fn () => json($dup);
        $e = Assert::throws(KpaxApiException::class, fn () => $this->client()->findDeviceBySerial('ABCD123456789'));
        Assert::same(409, $e->status);
    }

    /** B14 */
    public function testB14SearchDevicesForm(): void
    {
        $this->mock->handler = static fn () => json(['data' => [], 'meta' => ['current_page' => 1, 'last_page' => 1]]);
        $this->client()->searchDevices(
            parentType: 'account',
            parentId: 3,
            withChildren: true,
            attributes: [['namespace' => 'kpax.core.print.devices', 'name' => 'engine_count']],
            filters: [['namespace' => 'kpax.core.print.devices', 'name' => 'last_check', 'operator' => 'greater', 'value' => '2026-11-01 00:00:00']],
            attributesWithLastCheck: false,
            profileIds: [1, 4],
            perPage: 500,
        );
        $r = $this->mock->calls[0];
        Assert::same('POST', $r->method);
        Assert::same('/api/v1/devices/search', parse_url($r->url, PHP_URL_PATH));
        Assert::same('application/x-www-form-urlencoded', $r->headers['Content-Type']);
        $f = form($r->body);
        Assert::same('1', $f['with_children']);
        Assert::same('0', $f['attributes_with_last_check']);
        Assert::same('[{"namespace":"kpax.core.print.devices","name":"engine_count"}]', $f['attributes']);
        Assert::true(str_contains($f['filters'], '"operator":"greater"'), 'filter operator');
        Assert::same('1,4', $f['profile_id']);
        Assert::same('500', $f['per_page']);
    }

    /** B15 */
    public function testB15Volumes(): void
    {
        $this->mock->handler = static fn () => json(fixture('volumes.json'));
        $v = $this->client()->getDeviceVolumes(42, '2026-11-01', '2026-11-02', volumeName: 'engine_count');
        Assert::same(120, $v['engine_count']['2026-11-01']);
        Assert::same('/api/v1/devices/42/volumes', parse_url($this->mock->calls[0]->url, PHP_URL_PATH));
        Assert::same(
            ['interval' => 'daily', 'start_date' => '2026-11-01', 'end_date' => '2026-11-02', 'volume_name' => 'engine_count'],
            query($this->mock->calls[0]),
        );
    }

    /** B16 */
    public function testB16NullQueryOmittedAndPathEncoded(): void
    {
        $c = $this->client();
        $this->mock->handler = static fn () => json(fixture('supply-cycles.json'));
        Assert::same('TK-8345K', $c->getSupplyCycles(9, 'black')[0]['ref_part_number']);
        Assert::same('cartridge=black', parse_url($this->mock->calls[0]->url, PHP_URL_QUERY));
        $this->mock->handler = static fn () => json([]);
        $c->request('GET', '/devices/{id}', ['id' => 'a/b'], ['x' => null]);
        Assert::same('https://acme.kpax.cloud/api/v1/devices/a%2Fb', $this->mock->calls[1]->url);
    }

    /** B11 */
    public function testB11AlertHistoryAllPages(): void
    {
        $this->mock->handler = static fn (HttpRequest $r) => json(fixture('alerts-page-' . query($r)['page'] . '.json'));
        $events = $this->client()->getTechnicalAlertHistory(42);
        Assert::same(['Toner low', 'Paper jam'], array_map(static fn ($e) => $e->value, $events));
        Assert::same(4, $events[0]->occurrences);
        Assert::same(null, $events[1]->eventEndDate);
    }

    public function testFullDeviceKeepsRaw(): void
    {
        $this->mock->handler = static fn () => json(fixture('device-full.json'));
        $d = $this->client()->getDevice(42);
        Assert::same('SN0000000042', $d->serialNumber);
        Assert::same(152340, $d->raw['meters']['engine_count']['value']);
    }

    /** B17 */
    public function testB17TestConnectionNeverThrows(): void
    {
        $c = $this->client();
        Assert::true($c->testConnection()->ok, 'ok');
        $this->mock->tokenHandler = static fn () => json(['error' => 'invalid_client'], 401);
        $c->resetToken();
        $res = $c->testConnection();
        Assert::same([false, 'auth', 401], [$res->ok, $res->stage, $res->status]);
        Assert::same('config', KpaxClient::testCredentials('nope', 'a', 'b')->stage);
    }
}
