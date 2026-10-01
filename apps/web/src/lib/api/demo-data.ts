import type {
  Annotation,
  Asset,
  Box,
  Panorama,
  SavedView,
  Site,
  SiteBundle,
  SpaceNode,
  User,
  Vec3,
} from '$lib/types';

/** Seed data of the demo site. The outdoor mesh is generated from `demoBuildings`. */

export const users = {
  sato: { id: 'u-sato', name: '佐藤 美咲', initials: '佐', color: '#0f766e' },
  tanaka: { id: 'u-tanaka', name: '田中 健一', initials: '田', color: '#7c3aed' },
  suzuki: { id: 'u-suzuki', name: '鈴木 亮', initials: '鈴', color: '#c2410c' },
} satisfies Record<string, User>;

export const currentUser: User = users.sato;

const SITE = 'bay-energy';

function box(min: Vec3, max: Vec3): Box {
  return { min, max };
}

/** Footprint and height of the buildings in the procedural outdoor mesh. */
export interface DemoBuilding {
  nodeId: string;
  min: [number, number];
  max: [number, number];
  /** Slab elevations of each floor, then the roof. */
  levels: number[];
  color: string;
}

export const demoBuildings: DemoBuilding[] = [
  {
    nodeId: 'n-turbine',
    min: [-20, -10],
    max: [44, 30],
    levels: [0, 8, 15],
    color: '#c9ccc9',
  },
  {
    nodeId: 'n-admin',
    min: [-82, -44],
    max: [-52, -24],
    levels: [0, 4, 8, 12],
    color: '#d6d3cb',
  },
  {
    nodeId: 'n-utility',
    min: [52, -46],
    max: [80, -22],
    levels: [0, 8, 16],
    color: '#bfc4c4',
  },
];

const nodes: SpaceNode[] = [
  {
    id: 'n-site',
    siteId: SITE,
    parentId: null,
    kind: 'site',
    name: '湾岸エネルギーセンター',
    order: 0,
    bounds: box([-110, -80, -2], [110, 80, 40]),
  },
  {
    id: 'n-outdoor',
    siteId: SITE,
    parentId: 'n-site',
    kind: 'outdoor',
    name: '屋外',
    order: 0,
    bounds: box([-110, -80, -2], [110, 80, 40]),
  },
  {
    id: 'n-turbine',
    siteId: SITE,
    parentId: 'n-site',
    kind: 'building',
    name: 'タービン建屋',
    order: 1,
    bounds: box([-20, -10, 0], [44, 30, 16]),
  },
  {
    id: 'n-turbine-2f',
    siteId: SITE,
    parentId: 'n-turbine',
    kind: 'floor',
    name: '2F',
    order: 1,
    elevation: 8,
    bounds: box([-20, -10, 8], [44, 30, 15]),
  },
  {
    id: 'n-turbine-2f-control',
    siteId: SITE,
    parentId: 'n-turbine-2f',
    kind: 'area',
    name: '制御盤エリア',
    order: 0,
    bounds: box([-16, 0, 8], [10, 22, 13]),
  },
  {
    id: 'n-turbine-1f',
    siteId: SITE,
    parentId: 'n-turbine',
    kind: 'floor',
    name: '1F',
    order: 0,
    elevation: 0,
    bounds: box([-20, -10, 0], [44, 30, 8]),
  },
  {
    id: 'n-turbine-1f-pump',
    siteId: SITE,
    parentId: 'n-turbine-1f',
    kind: 'area',
    name: 'ポンプエリア',
    order: 0,
    bounds: box([10, -7, 0], [36, 12, 6]),
  },
  {
    id: 'n-turbine-1f-elec',
    siteId: SITE,
    parentId: 'n-turbine-1f',
    kind: 'area',
    name: '電気室',
    order: 1,
    bounds: box([-17, 13, 0], [4, 27, 5]),
  },
  {
    id: 'n-admin',
    siteId: SITE,
    parentId: 'n-site',
    kind: 'building',
    name: '管理棟',
    order: 2,
    bounds: box([-82, -44, 0], [-52, -24, 12]),
  },
  ...['1F', '2F', '3F'].map((name, i): SpaceNode => ({
    id: `n-admin-${i + 1}f`,
    siteId: SITE,
    parentId: 'n-admin',
    kind: 'floor',
    name,
    order: i,
    elevation: i * 4,
    bounds: box([-82, -44, i * 4], [-52, -24, i * 4 + 4]),
  })),
  {
    id: 'n-utility',
    siteId: SITE,
    parentId: 'n-site',
    kind: 'building',
    name: 'ユーティリティ棟',
    order: 3,
    bounds: box([52, -46, 0], [80, -22, 16]),
  },
];

const assets: Asset[] = [
  {
    id: 'a-drone-mesh',
    nodeId: 'n-outdoor',
    kind: 'mesh',
    name: '敷地全体メッシュ',
    source: 'ドローン写真測量',
    capturedAt: '2026-08-21',
    position: [0, 0, 0],
    rotationZ: 0,
  },
  {
    id: 'a-pump-a',
    nodeId: 'n-turbine-1f-pump',
    kind: 'pointcloud',
    name: 'ポンプエリア 東側',
    source: 'SLAM スキャナ',
    capturedAt: '2026-08-21',
    url: `/api/sites/${SITE}/assets/a-pump-a/files/metadata.json`,
    position: [13.5, -4.6, 0],
    rotationZ: 0,
    pointCount: 1_213_990,
  },
  {
    id: 'a-pump-b',
    nodeId: 'n-turbine-1f-pump',
    kind: 'pointcloud',
    name: 'ポンプエリア 西側',
    source: 'SLAM スキャナ',
    capturedAt: '2026-08-21',
    url: `/api/sites/${SITE}/assets/a-pump-b/files/metadata.json`,
    position: [32.5, 6.6, 0],
    rotationZ: 180,
    pointCount: 1_213_990,
  },
];

const panoramas: Panorama[] = [
  ['p-027', 'n-turbine-1f-pump', 'PANO-027', [12, 6, 1.6], 120],
  ['p-028', 'n-turbine-1f-pump', 'PANO-028', [20.5, 3.8, 1.6], 200],
  ['p-029', 'n-turbine-1f-pump', 'PANO-029', [26, 9.5, 1.6], 250],
  ['p-030', 'n-turbine-1f-elec', 'PANO-030', [-6, 20, 1.6], 90],
  ['p-031', 'n-turbine-2f-control', 'PANO-031', [-3, 11, 9.6], 0],
  ['p-001', 'n-outdoor', 'PANO-001', [10, -30, 1.6], 0],
  ['p-002', 'n-outdoor', 'PANO-002', [-45, 12, 1.6], 90],
  ['p-003', 'n-outdoor', 'PANO-003', [-66, -14, 1.6], 180],
].map(([id, nodeId, name, position, heading]) => ({
  id: id as string,
  nodeId: nodeId as string,
  name: name as string,
  position: position as Vec3,
  heading: heading as number,
  capturedAt: '2026-08-21',
}));

const placeholder = (name: string) =>
  `data:text/plain;charset=utf-8,${encodeURIComponent(`${name}（デモ用のダミーファイル）`)}`;

const annotations: Annotation[] = [
  {
    id: 'an-p101a',
    siteId: SITE,
    nodeId: 'n-turbine-1f-pump',
    category: 'equipment',
    code: 'P-101A',
    title: '冷却水ポンプ A',
    description:
      '復水器冷却水系の主ポンプ。定格 450 m³/h。B 号機と交互運転（毎月第 1 月曜に切替）。',
    position: [15.9, -2.1, 4.1],
    extent: box([13.5, -4.6, 0], [18.3, 0.4, 3.9]),
    links: [
      {
        id: 'l1',
        title: '設備台帳',
        system: '社内設備管理システム',
        url: 'https://assets.example.co.jp/equipment/P-101A',
      },
      {
        id: 'l2',
        title: '点検履歴',
        system: '保全管理システム',
        url: 'https://maint.example.co.jp/inspections?equipment=P-101A',
      },
      {
        id: 'l3',
        title: '関連図面',
        system: '文書管理システム',
        url: 'https://docs.example.co.jp/drawings/TB-1F-PUMP',
      },
    ],
    attachments: [
      {
        id: 'f1',
        name: 'P-101A_仕様書.pdf',
        size: 1_240_000,
        mimeType: 'application/pdf',
        url: placeholder('P-101A_仕様書.pdf'),
        uploadedBy: users.tanaka.name,
        uploadedAt: '2026-08-24T10:12:00+09:00',
      },
      {
        id: 'f2',
        name: '配置図_1F.pdf',
        size: 2_080_000,
        mimeType: 'application/pdf',
        url: placeholder('配置図_1F.pdf'),
        uploadedBy: users.tanaka.name,
        uploadedAt: '2026-08-24T10:13:00+09:00',
      },
    ],
    comments: [
      {
        id: 'c1',
        author: users.suzuki,
        body: 'メカニカルシール付近に軽微なにじみあり。次回点検で確認お願いします。',
        createdAt: '2026-09-12T14:20:00+09:00',
      },
      {
        id: 'c2',
        author: users.tanaka,
        body: '了解です。10/8 の定期点検で対応予定。点検履歴に起票済み。',
        createdAt: '2026-09-12T16:05:00+09:00',
      },
    ],
    createdBy: users.tanaka,
    createdAt: '2026-08-24T10:10:00+09:00',
    updatedAt: '2026-09-12T16:05:00+09:00',
  },
  {
    id: 'an-p101b',
    siteId: SITE,
    nodeId: 'n-turbine-1f-pump',
    category: 'equipment',
    code: 'P-101B',
    title: '冷却水ポンプ B',
    description: '復水器冷却水系の予備ポンプ。',
    position: [30.1, 4.1, 4.1],
    extent: box([27.7, 1.6, 0], [32.5, 6.6, 3.9]),
    links: [
      {
        id: 'l1',
        title: '設備台帳',
        system: '社内設備管理システム',
        url: 'https://assets.example.co.jp/equipment/P-101B',
      },
      {
        id: 'l2',
        title: '点検履歴',
        system: '保全管理システム',
        url: 'https://maint.example.co.jp/inspections?equipment=P-101B',
      },
    ],
    attachments: [],
    comments: [],
    createdBy: users.tanaka,
    createdAt: '2026-08-24T10:20:00+09:00',
    updatedAt: '2026-08-24T10:20:00+09:00',
  },
  {
    id: 'an-insulation',
    siteId: SITE,
    nodeId: 'n-turbine-1f-pump',
    category: 'issue',
    title: '吐出配管の保温材が劣化',
    description: '保温材の外装が一部めくれている。雨水の侵入はなし。',
    position: [17.6, -1.2, 3.4],
    links: [
      {
        id: 'l1',
        title: '是正依頼 #2291',
        system: '保全管理システム',
        url: 'https://maint.example.co.jp/requests/2291',
      },
    ],
    attachments: [],
    comments: [
      {
        id: 'c1',
        author: users.suzuki,
        body: '巡視で発見。写真は PANO-028 から確認できます。',
        createdAt: '2026-09-03T09:41:00+09:00',
      },
    ],
    createdBy: users.suzuki,
    createdAt: '2026-09-03T09:40:00+09:00',
    updatedAt: '2026-09-03T09:41:00+09:00',
  },
  {
    id: 'an-mcc1',
    siteId: SITE,
    nodeId: 'n-turbine-1f-elec',
    category: 'equipment',
    code: 'MCC-1',
    title: 'コントロールセンタ 1 号',
    description: '1F ポンプ類の動力盤。',
    position: [-10, 24, 2.4],
    links: [
      {
        id: 'l1',
        title: '単線結線図',
        system: '文書管理システム',
        url: 'https://docs.example.co.jp/drawings/EL-MCC-1',
      },
    ],
    attachments: [],
    comments: [],
    createdBy: users.tanaka,
    createdAt: '2026-08-25T13:00:00+09:00',
    updatedAt: '2026-08-25T13:00:00+09:00',
  },
  {
    id: 'an-cp201',
    siteId: SITE,
    nodeId: 'n-turbine-2f-control',
    category: 'equipment',
    code: 'CP-201',
    title: 'タービン制御盤',
    description: '',
    position: [-6, 16, 10.2],
    links: [],
    attachments: [],
    comments: [],
    createdBy: users.tanaka,
    createdAt: '2026-08-25T13:10:00+09:00',
    updatedAt: '2026-08-25T13:10:00+09:00',
  },
  {
    id: 'an-t01',
    siteId: SITE,
    nodeId: 'n-outdoor',
    category: 'equipment',
    code: 'T-01',
    title: '燃料タンク 1 号',
    description: '容量 2,000 kL。',
    position: [-76, 40, 13],
    links: [
      {
        id: 'l1',
        title: '設備台帳',
        system: '社内設備管理システム',
        url: 'https://assets.example.co.jp/equipment/T-01',
      },
    ],
    attachments: [],
    comments: [],
    createdBy: users.tanaka,
    createdAt: '2026-08-26T09:00:00+09:00',
    updatedAt: '2026-08-26T09:00:00+09:00',
  },
  {
    id: 'an-t02',
    siteId: SITE,
    nodeId: 'n-outdoor',
    category: 'equipment',
    code: 'T-02',
    title: '燃料タンク 2 号',
    description: '容量 2,000 kL。',
    position: [-56, 48, 13],
    links: [],
    attachments: [],
    comments: [],
    createdBy: users.tanaka,
    createdAt: '2026-08-26T09:00:00+09:00',
    updatedAt: '2026-08-26T09:00:00+09:00',
  },
  {
    id: 'an-muster',
    siteId: SITE,
    nodeId: 'n-outdoor',
    category: 'note',
    title: '避難時の集合場所',
    description: '管理棟前の駐車場。点呼は各課の責任者が行う。',
    position: [-66, -8, 0.5],
    links: [],
    attachments: [],
    comments: [],
    createdBy: users.sato,
    createdAt: '2026-08-28T11:00:00+09:00',
    updatedAt: '2026-08-28T11:00:00+09:00',
  },
];

const savedViews: SavedView[] = [
  {
    id: 'v-overview',
    siteId: SITE,
    name: '敷地全体',
    camera: { position: [-95, -150, 110], target: [0, 0, 0] },
    hiddenNodeIds: [],
    floorFilter: null,
    createdBy: users.sato,
    createdAt: '2026-08-28T11:00:00+09:00',
  },
  {
    id: 'v-pump',
    siteId: SITE,
    name: '1F ポンプエリア 俯瞰',
    camera: { position: [6, -22, 18], target: [22, 2, 1] },
    hiddenNodeIds: [],
    floorFilter: 'n-turbine-1f',
    createdBy: users.tanaka,
    createdAt: '2026-09-01T15:30:00+09:00',
  },
];

const site: Site = {
  id: SITE,
  name: '湾岸エネルギーセンター',
  address: '湾岸地区 3-1',
  crs: '施設ローカル',
  capturedAt: '2026-08-21',
  stats: { nodes: nodes.length, annotations: annotations.length, panoramas: panoramas.length },
};

export const demoSites: Site[] = [
  site,
  {
    id: 'north-plant',
    name: '北部浄水場',
    address: '北区 2-14',
    crs: '施設ローカル',
    capturedAt: '2026-06-02',
    stats: { nodes: 0, annotations: 0, panoramas: 0 },
  },
];

export function demoBundle(): SiteBundle {
  return structuredClone({ site, nodes, assets, panoramas, annotations, savedViews });
}
