import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  ValidationPipe,
} from '@nestjs/common';
import {
  KPAX_CONNECTION_STORE,
  KpaxClientFactory,
  KpaxConfigurationError,
  KpaxConnectionRegistry,
  KpaxConnectionView,
} from '@bizreflex/nestjs-kpax';
import { KpaxConnectionDbStore } from './kpax-connection.store';
import {
  CreateKpaxConnectionDto,
  TestKpaxConnectionDto,
  UpdateKpaxConnectionDto,
} from './kpax-connection.dto';

const validate = new ValidationPipe({ whitelist: true, transform: true });

/**
 * Admin endpoints for KPAX connections. ADD YOUR AUTH GUARDS: these manage
 * credentials. Each write is applied to this process's registry immediately;
 * other processes pick it up on first use or their next sync.
 */
@Controller('admin/kpax-connections')
export class KpaxConnectionsController {
  constructor(
    @Inject(KPAX_CONNECTION_STORE)
    private readonly store: KpaxConnectionDbStore,
    private readonly registry: KpaxConnectionRegistry,
    private readonly factory: KpaxClientFactory,
  ) {}

  @Get()
  async list() {
    return (await this.store.listViews()).map((v) => this.view(v));
  }

  @Post('test') // before ':id' routes
  @HttpCode(200)
  testUnsaved(@Body(validate) body: TestKpaxConnectionDto) {
    return this.factory.testConnection(body);
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return this.view(await this.require(id));
  }

  @Post()
  async create(@Body(validate) body: CreateKpaxConnectionDto) {
    const v = await this.guard(() => this.store.create(body));
    await this.registry.reload(v.id);
    return this.view(v);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body(validate) body: UpdateKpaxConnectionDto,
  ) {
    await this.require(id);
    const v = await this.guard(() => this.store.update(id, body));
    await this.registry.reload(v.id);
    return this.view(v);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string) {
    if (!(await this.store.softDelete(id))) throw new NotFoundException();
    this.registry.remove(id);
  }

  @Post(':id/test')
  @HttpCode(200)
  async testSaved(@Param('id') id: string) {
    const record = await this.store.findById(id);
    if (!record) throw new NotFoundException();
    return this.factory.testConnection(record);
  }

  private async require(id: string): Promise<KpaxConnectionView> {
    const v = await this.store.getView(id);
    if (!v) throw new NotFoundException();
    return v;
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof KpaxConfigurationError) {
        throw new BadRequestException(e.message);
      }
      throw e;
    }
  }

  private view(v: KpaxConnectionView) {
    return { ...v, loaded: this.registry.has(v.id) };
  }
}
