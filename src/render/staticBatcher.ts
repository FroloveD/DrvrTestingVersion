/**
 * @module render/staticBatcher
 * @layer three-render
 * @role Пакетная сборка статической 3D-геометрии по материалам и пространственным чанкам + O(1) пространственный индекс дорог для быстрой отрисовки крупных OSM-карт.
 * @invariants #1 (координаты +Z вперёд, +X влево), #8 (100 % офлайн), #13 (детерминированная статическая геометрия и корректный dispose).
 * @tests Смоук A, L, O, P (`tests/browser-smoke.mjs`)
 */
import * as THREE from "three";
import type { CrosswalkDef, ParkingBay, RoadSegment, TrafficSignalDef } from "../sim/types";

type Bucket = {
  material: THREE.Material;
  castShadow: boolean;
  receiveShadow: boolean;
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
};

export type BoxEmitOptions = {
  castShadow?: boolean;
  receiveShadow?: boolean;
  keepBottom?: boolean;
  /** Шаг повторения текстуры бордюра вдоль длины (м), например 2.0 для ГОСТ БР 100.30.15. */
  curbTileM?: number;
  curbAlongX?: boolean;
  /** Материал кровли: если задан, 4 стены получают мировой масштаб окон фасада, а верхняя грань уходит в `roofMat`. */
  roofMat?: THREE.Material;
};

export type WorldChunkHandle = {
  group: THREE.Group;
  cx: number;
  cz: number;
  radius: number;
  buildingCount: number;
};

const _pos = new THREE.Vector3();
const _norm = new THREE.Vector3();
const _normMat = new THREE.Matrix3();
const _mat4 = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _scale = new THREE.Vector3();

/** Накапливает статические примитивы по материалам и сливает каждый бакет в один `THREE.Mesh` (1 draw call). */
export class StaticBatcher {
  private readonly buckets = new Map<THREE.Material, Bucket[]>();

  private getBucket(material: THREE.Material, castShadow: boolean, receiveShadow: boolean): Bucket {
    let list = this.buckets.get(material);
    if (!list) {
      list = [];
      this.buckets.set(material, list);
    }
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (b.castShadow === castShadow && b.receiveShadow === receiveShadow) return b;
    }
    const created: Bucket = {
      material,
      castShadow,
      receiveShadow,
      positions: [],
      normals: [],
      uvs: [],
      indices: [],
    };
    list.push(created);
    return created;
  }

  /** Добавляет горизонтальный прямоугольник (`normal = +Y`) с произвольными UV. */
  addFlatQuad(
    mat: THREE.Material,
    cx: number,
    y: number,
    cz: number,
    width: number,
    length: number,
    yaw: number,
    receiveShadow = false,
    u0 = 0,
    v0 = 0,
    u1 = 1,
    v1 = 1
  ): void {
    const b = this.getBucket(mat, false, receiveShadow);
    const base = b.positions.length / 3;
    const hw = width * 0.5;
    const hl = length * 0.5;
    const s = Math.sin(yaw);
    const c = Math.cos(yaw);
    // Совпадает с PlaneGeometry(width, length) после rotation.order='YXZ', rotation.y=yaw, rotation.x=-PI/2:
    // локальный +X -> (c, 0, -s), локальный +Y (v=1) -> (-s, 0, -c)
    const rx = c * hw;
    const rz = -s * hw;
    const ux = -s * hl;
    const uz = -c * hl;

    const p = b.positions;
    // v0: (-hw, +hl) uv(u0,v1), v1: (+hw, +hl) uv(u1,v1), v2: (-hw, -hl) uv(u0,v0), v3: (+hw, -hl) uv(u1,v0)
    p.push(
      cx - rx + ux, y, cz - rz + uz,
      cx + rx + ux, y, cz + rz + uz,
      cx - rx - ux, y, cz - rz - uz,
      cx + rx - ux, y, cz + rz - uz
    );
    b.normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
    b.uvs.push(u0, v1, u1, v1, u0, v0, u1, v0);
    b.indices.push(base, base + 2, base + 1, base + 2, base + 3, base + 1);
  }

  /** Добавляет горизонтальный прямоугольник с непрерывными мировыми UV (для асфальта, плитки и разметки без швов). */
  addWorldUvQuad(
    mat: THREE.Material,
    cx: number,
    y: number,
    cz: number,
    width: number,
    length: number,
    yaw: number,
    tileU: number,
    tileV = tileU,
    receiveShadow = false,
    alignToSegment = false
  ): void {
    if (alignToSegment) {
      this.addFlatQuad(mat, cx, y, cz, width, length, yaw, receiveShadow, 0, 0, width / tileU, length / tileV);
      return;
    }
    const b = this.getBucket(mat, false, receiveShadow);
    const base = b.positions.length / 3;
    const hw = width * 0.5;
    const hl = length * 0.5;
    const s = Math.sin(yaw);
    const c = Math.cos(yaw);
    const rx = c * hw;
    const rz = -s * hw;
    const ux = -s * hl;
    const uz = -c * hl;

    const x0 = cx - rx + ux, z0 = cz - rz + uz;
    const x1 = cx + rx + ux, z1 = cz + rz + uz;
    const x2 = cx - rx - ux, z2 = cz - rz - uz;
    const x3 = cx + rx - ux, z3 = cz + rz - uz;

    b.positions.push(x0, y, z0, x1, y, z1, x2, y, z2, x3, y, z3);
    b.normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
    b.uvs.push(x0 / tileU, z0 / tileV, x1 / tileU, z1 / tileV, x2 / tileU, z2 / tileV, x3 / tileU, z3 / tileV);
    b.indices.push(base, base + 2, base + 1, base + 2, base + 3, base + 1);
  }

  /** Добавляет горизонтальный круг со сквозными мировыми UV (бесшовные стыки дорог и тротуаров в узлах). */
  addWorldUvDisc(
    mat: THREE.Material,
    cx: number,
    y: number,
    cz: number,
    radius: number,
    segments: number,
    tileM: number,
    receiveShadow = false
  ): void {
    const b = this.getBucket(mat, false, receiveShadow);
    const base = b.positions.length / 3;
    const inv = 1 / tileM;
    b.positions.push(cx, y, cz);
    b.normals.push(0, 1, 0);
    b.uvs.push(cx * inv, cz * inv);
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const wx = cx + Math.cos(a) * radius;
      const wz = cz - Math.sin(a) * radius;
      b.positions.push(wx, y, wz);
      b.normals.push(0, 1, 0);
      b.uvs.push(wx * inv, wz * inv);
    }
    for (let i = 1; i <= segments; i++) {
      b.indices.push(base, base + i, base + i + 1);
    }
  }

  /** Добавляет вертикальную плоскость (знак, табличка, торец) с поворотом вокруг Y и опциональным разворотом на 180°. */
  addVerticalQuad(
    mat: THREE.Material,
    cx: number,
    cy: number,
    cz: number,
    width: number,
    height: number,
    yaw: number,
    castShadow = false
  ): void {
    const b = this.getBucket(mat, castShadow, false);
    const base = b.positions.length / 3;
    const hw = width * 0.5;
    const hh = height * 0.5;
    const s = Math.sin(yaw);
    const c = Math.cos(yaw);
    const rx = c * hw;
    const rz = -s * hw;

    b.positions.push(
      cx - rx, cy + hh, cz - rz,
      cx + rx, cy + hh, cz + rz,
      cx - rx, cy - hh, cz - rz,
      cx + rx, cy - hh, cz + rz
    );
    b.normals.push(s, 0, c, s, 0, c, s, 0, c, s, 0, c);
    b.uvs.push(0, 1, 1, 1, 0, 0, 1, 0);
    b.indices.push(base, base + 2, base + 1, base + 2, base + 3, base + 1);
  }

  /**
   * Добавляет ориентированный вокруг Y параллелепипед без выделения `THREE.BoxGeometry` и без невидимого дна.
   * Поддерживает ГОСТ-повтор текстуры бордюра и разделение стен/кровли зданий с мировым масштабом окон.
   */
  addBox(
    mat: THREE.Material,
    cx: number,
    cy: number,
    cz: number,
    sx: number,
    sy: number,
    sz: number,
    yaw: number,
    opts?: BoxEmitOptions
  ): void {
    const cast = opts?.castShadow ?? false;
    const recv = opts?.receiveShadow ?? false;
    const b = this.getBucket(mat, cast, recv);
    const hx = sx * 0.5;
    const hy = sy * 0.5;
    const hz = sz * 0.5;
    const s = Math.sin(yaw);
    const c = Math.cos(yaw);
    // Локальные оси в мире: X -> (c, 0, -s), Z -> (s, 0, c)
    const pushQuad = (
      dst: Bucket,
      x0: number, y0: number, z0: number,
      x1: number, y1: number, z1: number,
      x2: number, y2: number, z2: number,
      x3: number, y3: number, z3: number,
      nx: number, ny: number, nz: number,
      ru: number, rv: number,
      swapTopUv = false
    ) => {
      const base = dst.positions.length / 3;
      dst.positions.push(
        cx + x0 * c + z0 * s, cy + y0, cz - x0 * s + z0 * c,
        cx + x1 * c + z1 * s, cy + y1, cz - x1 * s + z1 * c,
        cx + x2 * c + z2 * s, cy + y2, cz - x2 * s + z2 * c,
        cx + x3 * c + z3 * s, cy + y3, cz - x3 * s + z3 * c
      );
      const wnx = nx * c + nz * s;
      const wnz = -nx * s + nz * c;
      dst.normals.push(wnx, ny, wnz, wnx, ny, wnz, wnx, ny, wnz, wnx, ny, wnz);
      if (swapTopUv) {
        dst.uvs.push(rv, 0, rv, 1, 0, 0, 0, 1);
      } else {
        dst.uvs.push(0, rv, ru, rv, 0, 0, ru, 0);
      }
      dst.indices.push(base, base + 2, base + 1, base + 2, base + 3, base + 1);
    };

    let ruZ = 1, ruX = 1, rvY = 1, ruTop = 1, rvTop = 1, swapTop = false;
    if (opts?.roofMat) {
      const snapQ = (v: number) => Math.max(0.25, Math.round(v * 4) / 4);
      rvY = snapQ(sy / 12.4);
      ruZ = snapQ(sz / 12.8);
      ruX = snapQ(sx / 12.8);
      ruTop = Math.max(1, sx / 6);
      rvTop = Math.max(1, sz / 6);
    } else if (opts?.curbTileM) {
      const len = opts.curbAlongX ? sx : sz;
      const rep = Math.max(0.5, len / opts.curbTileM);
      if (opts.curbAlongX) {
        ruX = rep;
        ruTop = rep;
      } else {
        ruZ = rep;
        rvTop = rep;
        swapTop = true;
      }
    }

    // +X, -X, +Z, -Z (4 боковые грани с корректным CCW-обходом наружу)
    pushQuad(b, hx, hy, hz, hx, hy, -hz, hx, -hy, hz, hx, -hy, -hz, 1, 0, 0, ruZ, rvY);
    pushQuad(b, -hx, hy, -hz, -hx, hy, hz, -hx, -hy, -hz, -hx, -hy, hz, -1, 0, 0, ruZ, rvY);
    pushQuad(b, -hx, hy, hz, hx, hy, hz, -hx, -hy, hz, hx, -hy, hz, 0, 0, 1, ruX, rvY);
    pushQuad(b, hx, hy, -hz, -hx, hy, -hz, hx, -hy, -hz, -hx, -hy, -hz, 0, 0, -1, ruX, rvY);

    // +Y (верхняя грань / крыша)
    const topBucket = opts?.roofMat ? this.getBucket(opts.roofMat, false, recv) : b;
    pushQuad(topBucket, -hx, hy, -hz, hx, hy, -hz, -hx, hy, hz, hx, hy, hz, 0, 1, 0, ruTop, rvTop, swapTop);

    if (opts?.keepBottom) {
      pushQuad(b, -hx, -hy, hz, hx, -hy, hz, -hx, -hy, -hz, hx, -hy, -hz, 0, -1, 0, 1, 1);
    }
  }

  /** Сливает произвольную прототипную `BufferGeometry` с матрицей трансформации. */
  addGeometry(
    mat: THREE.Material,
    proto: THREE.BufferGeometry,
    matrix: THREE.Matrix4,
    castShadow = false,
    receiveShadow = false
  ): void {
    const posAttr = proto.attributes.position;
    if (!posAttr) return;
    const normAttr = proto.attributes.normal;
    const uvAttr = proto.attributes.uv;
    const idxAttr = proto.index;

    const b = this.getBucket(mat, castShadow, receiveShadow);
    const base = b.positions.length / 3;
    const count = posAttr.count;
    _normMat.getNormalMatrix(matrix);

    for (let i = 0; i < count; i++) {
      _pos.fromBufferAttribute(posAttr, i).applyMatrix4(matrix);
      b.positions.push(_pos.x, _pos.y, _pos.z);
      if (normAttr) {
        _norm.fromBufferAttribute(normAttr, i).applyMatrix3(_normMat).normalize();
        b.normals.push(_norm.x, _norm.y, _norm.z);
      } else {
        b.normals.push(0, 1, 0);
      }
      if (uvAttr) {
        b.uvs.push(uvAttr.getX(i), uvAttr.getY(i));
      } else {
        b.uvs.push(0, 0);
      }
    }

    if (idxAttr) {
      for (let i = 0; i < idxAttr.count; i++) {
        b.indices.push(base + idxAttr.getX(i));
      }
    } else {
      for (let i = 0; i < count; i++) {
        b.indices.push(base + i);
      }
    }
  }

  /** Удобная обёртка для слияния прототипа по позиции, углам Эйлера и масштабу без аллокаций. */
  addProto(
    mat: THREE.Material,
    proto: THREE.BufferGeometry,
    x: number,
    y: number,
    z: number,
    rx: number,
    ry: number,
    rz: number,
    sx: number,
    sy: number,
    sz: number,
    castShadow = false,
    receiveShadow = false,
    order: THREE.EulerOrder = "XYZ"
  ): void {
    _euler.set(rx, ry, rz, order);
    _quat.setFromEuler(_euler);
    _pos.set(x, y, z);
    _scale.set(sx, sy, sz);
    _mat4.compose(_pos, _quat, _scale);
    this.addGeometry(mat, proto, _mat4, castShadow, receiveShadow);
  }

  /** Собирает все накопленные бакеты в компактные `THREE.Mesh` и добавляет их в `target`. */
  flush(target: THREE.Group): number {
    let created = 0;
    this.buckets.forEach((list) => {
      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        const vertCount = b.positions.length / 3;
        if (vertCount === 0 || b.indices.length === 0) continue;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute(b.positions, 3));
        geo.setAttribute("normal", new THREE.Float32BufferAttribute(b.normals, 3));
        geo.setAttribute("uv", new THREE.Float32BufferAttribute(b.uvs, 2));
        geo.setIndex(
          vertCount > 65535
            ? new THREE.Uint32BufferAttribute(b.indices, 1)
            : new THREE.Uint16BufferAttribute(b.indices, 1)
        );
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, b.material);
        mesh.castShadow = b.castShadow;
        mesh.receiveShadow = b.receiveShadow;
        target.add(mesh);
        created++;
      }
    });
    this.buckets.clear();
    return created;
  }
}

type ChunkRecord = {
  batch: StaticBatcher;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  buildingCount: number;
};

/** Пространственный батчер: группирует статическую геометрию по квадратным чанкам для мгновенного отсечения вдали. */
export class SpatialChunkBatcher {
  private readonly cellSize: number;
  private readonly chunks = new Map<number, ChunkRecord>();

  constructor(cellSize = 110) {
    this.cellSize = cellSize;
  }

  private getRecord(x: number, z: number, pad = 2): ChunkRecord {
    const gx = Math.floor(x / this.cellSize);
    const gz = Math.floor(z / this.cellSize);
    const key = ((gx + 32768) << 16) | ((gz + 32768) & 0xffff);
    let rec = this.chunks.get(key);
    if (!rec) {
      rec = {
        batch: new StaticBatcher(),
        minX: x - pad,
        maxX: x + pad,
        minZ: z - pad,
        maxZ: z + pad,
        buildingCount: 0,
      };
      this.chunks.set(key, rec);
    } else {
      if (x - pad < rec.minX) rec.minX = x - pad;
      if (x + pad > rec.maxX) rec.maxX = x + pad;
      if (z - pad < rec.minZ) rec.minZ = z - pad;
      if (z + pad > rec.maxZ) rec.maxZ = z + pad;
    }
    return rec;
  }

  /** Возвращает батчер чанка, покрывающего точку `(x, z)` с запасом радиуса объекта `extent`. */
  at(x: number, z: number, extent = 2): StaticBatcher {
    return this.getRecord(x, z, extent).batch;
  }

  /** Регистрирует здание в чанке для точной метрики `visibleBuildings / totalBuildings`. */
  atBuilding(x: number, z: number, extent: number): StaticBatcher {
    const rec = this.getRecord(x, z, extent);
    rec.buildingCount++;
    return rec.batch;
  }

  /** Создаёт по одной `THREE.Group` на непустой чанк и возвращает дескрипторы для быстрого радиусного отсечения. */
  flush(parent: THREE.Group): WorldChunkHandle[] {
    const out: WorldChunkHandle[] = [];
    this.chunks.forEach((rec) => {
      const grp = new THREE.Group();
      const count = rec.batch.flush(grp);
      if (count === 0) return;
      const cx = (rec.minX + rec.maxX) * 0.5;
      const cz = (rec.minZ + rec.maxZ) * 0.5;
      const radius = Math.hypot(rec.maxX - cx, rec.maxZ - cz);
      parent.add(grp);
      out.push({ group: grp, cx, cz, radius, buildingCount: rec.buildingCount });
    });
    this.chunks.clear();
    return out;
  }
}

type IndexedSeg = {
  roadId: string;
  ax: number;
  az: number;
  abx: number;
  abz: number;
  invLenSq: number;
  halfW: number;
};

/** O(1) равномерная пространственная сетка для мгновенного поиска перекрёстков, переходов, боксов и стоп-линий. */
export class RoadSpatialIndex {
  private readonly cell = 24;
  private readonly segCells = new Map<number, IndexedSeg[]>();
  private readonly crosswalks: Array<{ cx: number; cz: number; sh: number; ch: number; halfL: number; halfW: number; rSq: number }> = [];
  private readonly bays: Array<{ cx: number; cz: number; sh: number; ch: number; limA: number; limC: number; rSq: number }> = [];
  private readonly controlPts: Array<{ x: number; z: number; rSq: number }> = [];

  constructor(
    streets: readonly RoadSegment[],
    crosswalks: readonly CrosswalkDef[],
    bays: readonly ParkingBay[],
    signals: readonly TrafficSignalDef[]
  ) {
    const maxPad = 4.2;
    for (let r = 0; r < streets.length; r++) {
      const road = streets[r];
      const hw = road.width * 0.5;
      const reach = hw + maxPad;
      const pts = road.points;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const abx = b.x - a.x;
        const abz = b.z - a.z;
        const lenSq = abx * abx + abz * abz;
        if (lenSq < 1e-4) continue;
        const entry: IndexedSeg = { roadId: road.id, ax: a.x, az: a.z, abx, abz, invLenSq: 1 / lenSq, halfW: hw };
        const gx0 = Math.floor((Math.min(a.x, b.x) - reach) / this.cell);
        const gx1 = Math.floor((Math.max(a.x, b.x) + reach) / this.cell);
        const gz0 = Math.floor((Math.min(a.z, b.z) - reach) / this.cell);
        const gz1 = Math.floor((Math.max(a.z, b.z) + reach) / this.cell);
        for (let gx = gx0; gx <= gx1; gx++) {
          for (let gz = gz0; gz <= gz1; gz++) {
            const k = ((gx + 32768) << 16) | ((gz + 32768) & 0xffff);
            let bucket = this.segCells.get(k);
            if (!bucket) {
              bucket = [];
              this.segCells.set(k, bucket);
            }
            bucket.push(entry);
          }
        }
      }
    }

    for (const cw of crosswalks) {
      const halfL = Math.max(cw.length * 0.5, 1.8);
      const halfW = cw.width * 0.5 + 2.4;
      const maxR = Math.hypot(halfL + 3.5, halfW + 3.5);
      this.crosswalks.push({ cx: cw.cx, cz: cw.cz, sh: Math.sin(cw.h), ch: Math.cos(cw.h), halfL, halfW, rSq: maxR * maxR });
      this.controlPts.push({ x: cw.cx, z: cw.cz, rSq: 15 * 15 });
    }
    for (const bay of bays) {
      const limA = bay.length * 0.5 + 1.8;
      const limC = bay.width * 0.5 + 2.2;
      this.bays.push({ cx: bay.cx, cz: bay.cz, sh: Math.sin(bay.h), ch: Math.cos(bay.h), limA, limC, rSq: limA * limA + limC * limC });
    }
    for (const sig of signals) {
      this.controlPts.push({ x: sig.stopLineX, z: sig.stopLineZ, rSq: 18 * 18 });
    }
  }

  inJunction(px: number, pz: number, ownRoadId: string, pad = 1.5): boolean {
    const gx = Math.floor(px / this.cell);
    const gz = Math.floor(pz / this.cell);
    const bucket = this.segCells.get(((gx + 32768) << 16) | ((gz + 32768) & 0xffff));
    if (!bucket) return false;
    for (let i = 0; i < bucket.length; i++) {
      const s = bucket[i];
      if (s.roadId === ownRoadId) continue;
      let t = ((px - s.ax) * s.abx + (pz - s.az) * s.abz) * s.invLenSq;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const dx = px - (s.ax + s.abx * t);
      const dz = pz - (s.az + s.abz * t);
      const lim = s.halfW + pad;
      if (dx * dx + dz * dz <= lim * lim) return true;
    }
    return false;
  }

  inCrosswalk(px: number, pz: number, pad = 0.9): boolean {
    for (let i = 0; i < this.crosswalks.length; i++) {
      const cw = this.crosswalks[i];
      const dx = px - cw.cx;
      const dz = pz - cw.cz;
      if (dx * dx + dz * dz > cw.rSq) continue;
      if (Math.abs(dx * cw.sh + dz * cw.ch) <= cw.halfL + pad && Math.abs(dx * cw.ch - dz * cw.sh) <= cw.halfW + pad) {
        return true;
      }
    }
    return false;
  }

  inBayOpening(px: number, pz: number): boolean {
    for (let i = 0; i < this.bays.length; i++) {
      const b = this.bays[i];
      const dx = px - b.cx;
      const dz = pz - b.cz;
      if (dx * dx + dz * dz > b.rSq) continue;
      if (Math.abs(dx * b.sh + dz * b.ch) <= b.limA && Math.abs(dx * b.ch - dz * b.sh) <= b.limC) {
        return true;
      }
    }
    return false;
  }

  nearControlZone(px: number, pz: number): boolean {
    for (let i = 0; i < this.controlPts.length; i++) {
      const c = this.controlPts[i];
      const dx = px - c.x;
      const dz = pz - c.z;
      if (dx * dx + dz * dz <= c.rSq) return true;
    }
    return false;
  }
}
