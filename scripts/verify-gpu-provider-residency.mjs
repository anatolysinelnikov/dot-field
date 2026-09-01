import { GpuWeatherProviderResidency } from '../src/engine/gpu-weather-provider-residency.js';

class FakeGl {
  constructor() {
    this.TEXTURE_2D = 1; this.TEXTURE_2D_ARRAY = 2; this.TEXTURE0 = 100;
    this.TEXTURE_MIN_FILTER = 3; this.TEXTURE_MAG_FILTER = 4; this.NEAREST = 5;
    this.R16F = 6; this.RG16F = 7; this.R32F = 8; this.RGBA32F = 9; this.RED = 10; this.RGBA = 11; this.HALF_FLOAT = 12; this.FLOAT = 13;
    this.ACTIVE_TEXTURE = 14; this.MAX_COMBINED_TEXTURE_IMAGE_UNITS = 15; this.TEXTURE_BINDING_2D = 16; this.TEXTURE_BINDING_2D_ARRAY = 17;
    this.MAX_TEXTURE_SIZE = 18; this.MAX_ARRAY_TEXTURE_LAYERS = 19;
    this.UNPACK_ALIGNMENT = 20; this.UNPACK_ROW_LENGTH = 21; this.UNPACK_IMAGE_HEIGHT = 22; this.UNPACK_SKIP_PIXELS = 23; this.UNPACK_SKIP_ROWS = 24; this.UNPACK_SKIP_IMAGES = 25;
    this.nextTexture = 0; this.active = this.TEXTURE0; this.bindings = new Map(); this.deleted = [];
  }
  createTexture() { return { id: ++this.nextTexture }; }
  bindTexture(target, texture) { this.bindings.set(`${this.active}:${target}`, texture); }
  texParameteri() {}
  texImage2D() {}
  texImage3D() {}
  texSubImage3D() {}
  pixelStorei() {}
  activeTexture(unit) { this.active = unit; }
  getParameter(parameter) {
    if (parameter === this.ACTIVE_TEXTURE) return this.active;
    if (parameter === this.MAX_COMBINED_TEXTURE_IMAGE_UNITS) return 4;
    if (parameter === this.MAX_TEXTURE_SIZE) return 4096;
    if (parameter === this.MAX_ARRAY_TEXTURE_LAYERS) return 64;
    if (parameter >= this.UNPACK_ALIGNMENT && parameter <= this.UNPACK_SKIP_IMAGES) return parameter === this.UNPACK_ALIGNMENT ? 4 : 0;
    if (parameter === this.TEXTURE_BINDING_2D || parameter === this.TEXTURE_BINDING_2D_ARRAY) return this.bindings.get(`${this.active}:${parameter === this.TEXTURE_BINDING_2D ? this.TEXTURE_2D : this.TEXTURE_2D_ARRAY}`) || null;
    return null;
  }
  deleteTexture(texture) { this.deleted.push(texture); }
}

const metadata = {
  generation_id: 'provider-test-generation',
  time: { count: 2 },
  spatial_grid: { width: 2, height: 2 },
  motion: { interval_count: 1 },
  temporal_tiles: { contract_version: 'dot-field-temporal-tiles-v1', tile_interior_source_nodes: 128, rain_halo_source_nodes: 1, tiles: [] }
};

function check(condition, message) { if (!condition) throw new Error(message); }

const gl = new FakeGl();
const provider = new GpuWeatherProviderResidency(gl, '/metadata.json', metadata, {});
const first = await provider.acquire([]);
const second = await provider.acquire([]);
check(first && second, 'provider should publish an empty but valid revision');
check(first !== second, 'each target acquisition must receive a distinct ownership handle');
check(first.revisionId === second.revisionId, 'same required set must reuse one provider revision');
check(first.slots === second.slots, 'targets must share the immutable slot mapping');
check(provider.diagnostics().providerRevisionCount === 1, 'one live provider revision should exist');
check(provider.diagnostics().providerOwnerCount === 1, 'creator reference should be explicit');

first.release();
check(provider.diagnostics().active, 'target-first release must leave provider residency valid');
second.release();
check(provider.diagnostics().active, 'provider creator reference must keep the atlas valid');
const deletedBeforeFinalRelease = gl.deleted.length;
provider.release();
check(!provider.diagnostics().active, 'final provider release must destroy the revision');
check(gl.deleted.length > deletedBeforeFinalRelease, 'final provider release must delete provider textures');
check(!provider.release(), 'repeated provider cleanup must be idempotent');

const staleGl = new FakeGl();
const staleProvider = new GpuWeatherProviderResidency(staleGl, '/metadata.json', metadata, {});
const staleBuild = staleProvider.acquire([]);
staleProvider.destroy();
check(await staleBuild === null, 'stale provider build must not publish after final destruction');
check(staleGl.deleted.length === 0, 'stale empty build must not create provider textures after destruction');

const multiMetadata = {
  generation_id: 'multichunk-provider-test-generation',
  time: { count: 2 },
  spatial_grid: { width: 4, height: 4 },
  motion: { interval_count: 1 },
  temporal_tiles: {
    contract_version: 'dot-field-temporal-tiles-v1',
    tile_interior_source_nodes: 128,
    rain_halo_source_nodes: 1,
    tiles: ['0,0', '1,0'].map((id) => ({
      id,
      rain: { stored_width: 2, stored_height: 2, stored_x_start: 0, stored_y_start: 0, byte_length: 16 },
      motion: { grid_width: 2, grid_height: 2, grid_x_start: 0, grid_y_start: 0, byte_length: 64 }
    }))
  }
};
const multiGl = new FakeGl();
const multiProvider = new GpuWeatherProviderResidency(multiGl, '/metadata.json', multiMetadata, {});
multiProvider.loadTilePayload = async () => ({ rain: new Uint16Array(8), motion: new Float32Array(16) });
const union = multiProvider.requiredTileUnion([['1,0'], ['0,0', '1,0']]);
check(union.join(',') === '0,0,1,0', 'multi-chunk provider requirements form one deterministic union');
const unionHandle = await multiProvider.acquire(union);
const targetARevision = multiProvider.retainPreparedRevision(unionHandle, ['0,0']);
const targetBRevision = multiProvider.retainPreparedRevision(unionHandle, ['1,0']);
check(multiProvider.diagnostics().providerRevisionCount === 1, 'multi-chunk union creates one live provider revision');
check(targetARevision.revisionId === targetBRevision.revisionId, 'all chunk targets retain the same provider revision ID');
check(targetARevision.rain === targetBRevision.rain && targetARevision.motion === targetBRevision.motion
  && targetARevision.info === targetBRevision.info, 'all chunk targets share provider atlas and lookup textures');
targetARevision.release();
check(multiProvider.diagnostics().active, 'destroying one target revision handle preserves shared provider resources');
targetBRevision.release();
unionHandle.release();
const multiDeletedBeforeFinalRelease = multiGl.deleted.length;
multiProvider.release();
check(multiGl.deleted.length > multiDeletedBeforeFinalRelease, 'final shared provider release destroys provider resources exactly once');
check(multiProvider.diagnostics().providerRevisionCount === 0, 'final shared provider release removes the live union revision');

console.log('GPU provider residency verification passed: explicit creator/target references, stable revision slot mapping, target-first cleanup, final provider cleanup, idempotent cleanup, and stale build rejection');
