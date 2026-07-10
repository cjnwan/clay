import * as THREE from 'three';
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import Box3D from 'box3d.js/inline';
import { BODY_TEMPLATES, bakeBodyMesh, buildWorkshopStage, WORKSHOP_POS, PARTS, buildPart, buildHoodPart } from './workshop.js';

// ---------- 常量 ----------

const COARSE = matchMedia( '(pointer: coarse)' ).matches;

const BOARD_HALF = 2.6;          // 黏土盘半径（物理围墙内侧）
const FIELD_S = 3.4;             // metaball 场半尺寸：世界 x/z ∈ [-S,S]，y ∈ [0,2S]
const RES = COARSE ? 36 : 52;    // marching cubes 分辨率（触屏设备多为移动端，降一档）
const SUBTRACT = 12;             // metaball 场衰减系数（官方示例同款）
const CLAY_R = 0.5;              // 黏土球物理半径
const CLAY_R_VIS = 0.62;         // 视觉半径略大于物理半径，贴住时看起来融为一体
const EYE_R = 0.21;
const MAX_CLAY = 36;
const MAX_DECOR = 24;            // 眼睛/嘴巴/帽子的总配额
const STEP = 1 / 60;
const LIFT_Y = 1.15;             // 拖拽时把球提到的高度
const STICK_SPEED = 2.5;         // 黏土互黏的相对速度上限
const DECOR_STICK_SPEED = 7;     // 贴件更黏：从空中掉到黏土上也直接粘住
const CLAY_COLORS = [
	0xe0584b, 0xf2a34d, 0xf6d155, 0x7dbb5f, 0x53a7dd, 0xa06bc9, // 红橙黄绿蓝紫
	0xf7f3ec, 0x3a3430, 0x9c6b4a, 0xf2a7c4, 0xa9a9ae, 0xf2e0c2, // 白黑棕粉灰奶油
];
const DAB_COLORS = CLAY_COLORS.map( ( c ) => new THREE.Color( c ) );
const BG = 0xefe0c8;
const FIELD_Y0 = - 0.2;          // 场底比桌面低一点，黏土底部才不会被切出开口，还有“压扁”效果
const DETACH_COOLDOWN = 1500;    // 双击拆开后这对球多久内不再自动黏回（毫秒）
const MORPH_HOLD_MS = 500;       // 按住多久开始变形 / 每级变形间隔
const MAX_DENTS = 18;            // 每块黏土最多保留的坑/包/彩点数，满了顶掉最旧的
const DENT_R = 0.3;              // 凹坑雕刻半径（负球在已有场里有效范围偏小，取大一点）
const DENT_STEP = 0.2;           // 划动捏坑时相邻坑的最小间距（世界单位）

// 黏土形态：按住循环切换。sub = metaball 子球（局部偏移 + 视觉半径，均按件的大小系数 k 缩放）
// pickR 用于点选包围球，stickR 用于黏住判定
const FORMS = [
	{ name: 'ball', pickR: 0.62, stickR: 0.5, sub: [ { o: [ 0, 0, 0 ], r: 0.62 } ] },
	{ name: 'flat', pickR: 0.78, stickR: 0.55, sub: [
		{ o: [ 0, 0, 0 ], r: 0.34 },
		...Array.from( { length: 8 }, ( _, i ) => {
			const a = ( i / 8 ) * Math.PI * 2;
			return { o: [ Math.cos( a ) * 0.37, 0, Math.sin( a ) * 0.37 ], r: 0.29 };
		} ),
	] },
	{ name: 'long', pickR: 0.92, stickR: 0.75, sub: [
		{ o: [ - 0.44, 0, 0 ], r: 0.4 },
		{ o: [ 0, 0, 0 ], r: 0.44 },
		{ o: [ 0.44, 0, 0 ], r: 0.4 },
	] },
	{ name: 'brick', pickR: 0.72, stickR: 0.6, sub: [
		{ o: [ - 0.22, 0, - 0.22 ], r: 0.34 },
		{ o: [ 0.22, 0, - 0.22 ], r: 0.34 },
		{ o: [ - 0.22, 0, 0.22 ], r: 0.34 },
		{ o: [ 0.22, 0, 0.22 ], r: 0.34 },
	] },
];

// 三档大小（半径倍率）：小 / 中 / 大
const SIZES = [ 0.72, 1, 1.4 ];
const CHAIN_SEGS = 4;            // 🐍 软链的节数
const CHAIN_K = 0.68;            // 链节相对当前档的大小

// 贴件：r = 物理球半径，out = 焊到圆球黏土上时中心到黏土视觉表面的外推量
const DECOR = {
	eye: { r: EYE_R, out: EYE_R * 0.5 },
	mouth: { r: 0.12, out: 0.04 },
	hat: { r: 0.12, out: 0.02 },
	bow: { r: 0.12, out: 0 },
};

// ---------- 模块状态 ----------

let b3, world;
let renderer, scene, camera, effect;
let balls = [];                  // { id, kind:'clay'|'eye', body, r, color, strength, mesh, alive }
let joints = [];                 // { joint, aId, bId, key }
const weldedKeys = new Set();
const noStickUntil = new Map();  // pair key → 时间戳：拆开后的冷却期内不再自动焊回
let nextId = 1;
let selected = 0;
let sizeIndex = 1;               // ⚪ 当前大小档
let drag = null;                 // { rec, target: Vector3, targetQuat, surface }
let session = null;              // 当前指针会话
let tentative = null;            // 贴件精确放置后的待确认状态 { rec, host, isNew, restore, timer }
let snapRing = null;             // 表面吸附时的落点指示环（懒创建）
let confirmBarEl = null;
let workshop = null;             // 🧸 工坊态：{ tplIndex, colorIndex, yaw, yawVel, bodyMat, figureMesh }
let wsStage = null;              // 工坊转盘台（懒创建，{ group, figure }）
let wsKeep = null;               // 离开工坊时留档，再进来还是那只
let wsDrag = null;               // 工坊里的转盘拖拽 { id, lastX }
let wsPlace = null;              // 工坊部件放置拖拽 { id, entry, isNew, pinch }
let wsShelf = null;              // 货架按钮的待拖出会话 { id, partId, x0, y0 }
const MAX_WS_PARTS = 24;
let camBlend = 0;                // 相机混合：0=黏土板 1=工坊
const boardCamPos = new THREE.Vector3();
const WS_CAM_OFF = new THREE.Vector3( 0, 2.3, 6.2 );
const WS_LOOK_OFF = new THREE.Vector3( 0, 1.05, 0 );
const _wsA = new THREE.Vector3();
const _wsB = new THREE.Vector3();
let lastTap = { rec: null, t: 0 };
let pendingHop = null;           // { rec, timer }：单击的跳跃延迟到双击窗口之后
let mode = null;                 // 工具模式：null | 'knead' 捏 | 'cut' 剪 | 'paint' 上色
let stickyEnabled = true;
let demoRun = null;              // 🎬 表演模式的运行令牌（置 null 即中止）
let demoIndex = 0;
let demoArmedAt = 0;             // 有作品时需要 2.5s 内再点一次确认
let hintEl = null;
let defaultHint = '';

const MODE_HINTS = {
	knead: '🤏 按一按戳坑 · 划一划刻沟 · 划出边缘鼓个包 · 再点收手',
	cut: '✂️ 点一下黏土剪成两半 · 点小蛇剪断 · 再点收手',
	paint: '🖌 选个颜色，在黏土上点一点、划一划上色 · 再点收手',
};

function setHint( text ) {

	if ( hintEl ) hintEl.textContent = text;

}

function resetHint() {

	setHint( mode ? MODE_HINTS[ mode ] : defaultHint );

}
let stepCount = 0;
let lastDirty = 0;
let builtOnce = false;

const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
const UP = new THREE.Vector3( 0, 1, 0 );
const Z_OUT = new THREE.Vector3( 0, 0, 1 ); // 贴件的“朝外”轴

// 复用对象，避免每帧分配
const _plane = new THREE.Plane();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

// 出生弹跳缓动（略微过冲）
function easeOutBack( t ) {

	const c1 = 1.70158, c3 = c1 + 1;
	return 1 + c3 * Math.pow( t - 1, 3 ) + c1 * Math.pow( t - 1, 2 );

}
const _sphere = new THREE.Sphere();
const _q = new THREE.Quaternion();

// 贴件的网格构造器（几何/材质在 init 里创建后填充）
const decorBuilders = {};

// ---------- 初始化 ----------

async function init() {

	renderer = new THREE.WebGLRenderer( { antialias: true } );
	renderer.setPixelRatio( Math.min( devicePixelRatio, 2 ) );
	renderer.setSize( innerWidth, innerHeight );
	renderer.shadowMap.enabled = true;
	renderer.shadowMap.type = THREE.PCFShadowMap;
	renderer.toneMapping = THREE.NeutralToneMapping;
	document.body.appendChild( renderer.domElement );

	b3 = await Box3D();

	// 场景与相机
	scene = new THREE.Scene();
	scene.background = new THREE.Color( BG );
	scene.fog = new THREE.Fog( BG, 14, 26 );

	// 环境光照（PMREM）：材质的“润”主要来自这里；强度压低，别冲掉暖色
	{
		const pmrem = new THREE.PMREMGenerator( renderer );
		const room = new RoomEnvironment();
		scene.environment = pmrem.fromScene( room, 0.04 ).texture;
		scene.environmentIntensity = 0.3;
		pmrem.dispose();
	}

	camera = new THREE.PerspectiveCamera( 40, innerWidth / innerHeight, 0.1, 60 );
	frameCamera();

	// 灯光：环境贴图打底，天光减弱，一盏投影主灯（约 4:1 光比），黏土要的是软阴影
	scene.add( new THREE.HemisphereLight( 0xfff6e8, 0xc9b391, 0.75 ) );

	const sun = new THREE.DirectionalLight( 0xfff2e0, 2.0 );
	sun.position.set( 4, 9, 5 );
	sun.castShadow = true;
	const shadowRes = COARSE ? 1024 : 2048;
	sun.shadow.mapSize.set( shadowRes, shadowRes );
	sun.shadow.camera.left = - 5;
	sun.shadow.camera.right = 5;
	sun.shadow.camera.top = 5;
	sun.shadow.camera.bottom = - 5;
	sun.shadow.camera.near = 1;
	sun.shadow.camera.far = 20;
	sun.shadow.bias = - 0.0005;
	scene.add( sun );

	// 黏土盘（视觉）：径向渐变贴图，中心亮四周暗，托出主体
	const boardTex = ( () => {

		const cv = document.createElement( 'canvas' );
		cv.width = cv.height = 256;
		const g = cv.getContext( '2d' );
		const grad = g.createRadialGradient( 128, 128, 30, 128, 128, 128 );
		grad.addColorStop( 0, '#eedbbc' );
		grad.addColorStop( 0.72, '#e5ceac' );
		grad.addColorStop( 1, '#cfb48d' );
		g.fillStyle = grad;
		g.fillRect( 0, 0, 256, 256 );
		const tex = new THREE.CanvasTexture( cv );
		tex.colorSpace = THREE.SRGBColorSpace;
		return tex;

	} )();
	const board = new THREE.Mesh(
		new THREE.CylinderGeometry( BOARD_HALF + 1.2, BOARD_HALF + 1.5, 0.5, 64 ),
		new THREE.MeshStandardMaterial( { map: boardTex, roughness: 0.92 } )
	);
	board.position.y = - 0.25;
	board.receiveShadow = true;
	scene.add( board );

	// 盘沿（视觉提示：黏土出不去）
	const rim = new THREE.Mesh(
		new THREE.TorusGeometry( BOARD_HALF + 0.28, 0.2, 20, 80 ),
		new THREE.MeshStandardMaterial( { color: 0xc9a26a, roughness: 0.8 } )
	);
	rim.rotation.x = Math.PI / 2;
	rim.position.y = 0.1;
	rim.castShadow = true;
	rim.receiveShadow = true;
	scene.add( rim );

	// metaball 黏土：逐球颜色 + 轻微清漆层 = 橡皮泥微微发润的质感
	const clayMaterial = new THREE.MeshPhysicalMaterial( {
		roughness: 0.58,
		metalness: 0,
		clearcoat: 0.15,
		clearcoatRoughness: 0.5,
		envMapIntensity: 0.5,
		vertexColors: true,
	} );
	effect = new MarchingCubes( RES, clayMaterial, false, true, 100000 );
	effect.position.set( 0, FIELD_S + FIELD_Y0, 0 );
	effect.scale.set( FIELD_S, FIELD_S, FIELD_S );
	effect.castShadow = true;
	effect.receiveShadow = true;
	scene.add( effect );


	// 贴件的共享几何/材质与构造器。约定：网格的 +Z 朝外（焊接时转向黏土外侧）
	{
		const eyeWhiteGeo = new THREE.SphereGeometry( EYE_R, 24, 16 );
		const eyePupilGeo = new THREE.SphereGeometry( EYE_R * 0.5, 16, 12 );
		const eyeWhiteMat = new THREE.MeshStandardMaterial( { color: 0xffffff, roughness: 0.15 } );
		const eyePupilMat = new THREE.MeshStandardMaterial( { color: 0x2b2420, roughness: 0.1 } );

		decorBuilders.eye = () => {

			const g = new THREE.Group();
			const white = new THREE.Mesh( eyeWhiteGeo, eyeWhiteMat );
			white.castShadow = true;
			const pupil = new THREE.Mesh( eyePupilGeo, eyePupilMat );
			pupil.position.z = EYE_R * 0.62;
			g.add( white, pupil );
			return g;

		};

		const mouthGeo = new THREE.TorusGeometry( 0.17, 0.05, 10, 20, Math.PI );
		const mouthMat = new THREE.MeshStandardMaterial( { color: 0xa03a2c, roughness: 0.55 } );

		decorBuilders.mouth = () => {

			const g = new THREE.Group();
			const arc = new THREE.Mesh( mouthGeo, mouthMat );
			arc.rotation.z = Math.PI; // 弧口朝上 = 微笑
			arc.scale.z = 0.7;
			arc.castShadow = true;
			g.add( arc );
			return g;

		};

		const coneGeo = new THREE.ConeGeometry( 0.3, 0.5, 20 );
		const brimGeo = new THREE.TorusGeometry( 0.29, 0.045, 8, 24 );
		const pomGeo = new THREE.SphereGeometry( 0.08, 12, 8 );
		const hatMat = new THREE.MeshStandardMaterial( { color: 0xe0584b, roughness: 0.7 } );
		const hatTrimMat = new THREE.MeshStandardMaterial( { color: 0xf0b64e, roughness: 0.55 } );

		const bowWingGeo = new THREE.ConeGeometry( 0.13, 0.22, 12 );
		const bowKnotGeo = new THREE.SphereGeometry( 0.07, 12, 8 );
		const bowMat = new THREE.MeshStandardMaterial( { color: 0xc9364a, roughness: 0.6 } );

		decorBuilders.bow = () => {

			const g = new THREE.Group();
			const l = new THREE.Mesh( bowWingGeo, bowMat );
			l.rotation.z = Math.PI / 2;   // 锥尖指向 -x → 左翼
			l.position.x = - 0.14;
			l.scale.z = 0.55;
			l.castShadow = true;
			const r = new THREE.Mesh( bowWingGeo, bowMat );
			r.rotation.z = - Math.PI / 2;
			r.position.x = 0.14;
			r.scale.z = 0.55;
			r.castShadow = true;
			const knot = new THREE.Mesh( bowKnotGeo, bowMat );
			knot.position.z = 0.03;
			g.add( l, r, knot );
			return g;

		};

		decorBuilders.hat = () => {

			const g = new THREE.Group();
			// 整体沿锥轴下沉 0.12：帽檐视觉上嵌进头顶，物理仍无穿透
			const cone = new THREE.Mesh( coneGeo, hatMat );
			cone.rotation.x = Math.PI / 2; // 锥轴从 +Y 转到 +Z
			cone.position.z = 0.13;
			cone.castShadow = true;
			const brim = new THREE.Mesh( brimGeo, hatTrimMat );
			brim.position.z = - 0.12;
			const pom = new THREE.Mesh( pomGeo, hatTrimMat );
			pom.position.z = 0.4;
			g.add( cone, brim, pom );
			return g;

		};
	}

	// 物理世界
	const worldDef = b3.b3DefaultWorldDef();
	worldDef.gravity = { x: 0, y: - 12, z: 0 };
	world = b3.b3CreateWorld( worldDef );

	// 地面：一块大而扁的静态盒子，顶面在 y = 0
	{
		const bd = b3.b3DefaultBodyDef();
		bd.position = { x: 0, y: - 0.5, z: 0 };
		const ground = b3.b3CreateBody( world, bd );
		const sd = b3.b3DefaultShapeDef();
		sd.baseMaterial.friction = 0.9;
		sd.baseMaterial.restitution = 0.02;
		b3.b3CreateBoxShape( ground, sd, BOARD_HALF + 2, 0.5, BOARD_HALF + 2 );
	}

	// 围墙：八块盒子围成八边形，近似圆盘边缘（box3d 的 box 形状不带局部偏移，逐个建静态体再旋转）
	{
		const wallR = BOARD_HALF + 0.25;
		for ( let i = 0; i < 8; i ++ ) {

			const a = ( i / 8 ) * Math.PI * 2;
			const bd = b3.b3DefaultBodyDef();
			bd.position = { x: Math.cos( a ) * wallR, y: 2, z: Math.sin( a ) * wallR };
			const wall = b3.b3CreateBody( world, bd );
			const sd = b3.b3DefaultShapeDef();
			sd.baseMaterial.friction = 0.4;
			b3.b3CreateBoxShape( wall, sd, 0.25, 2.5, BOARD_HALF * 0.55 );

			// 长轴（local z）要与径向垂直：绕 Y 旋转 -a，使厚度方向（local x）指向圆心
			_q.setFromAxisAngle( UP, - a );
			b3.b3Body_SetTransform( wall, bd.position, { v: { x: _q.x, y: _q.y, z: _q.z }, s: _q.w } );

		}
	}

	setupUI();
	setupPointer();

	// 优先恢复上次的作品（URL hash > localStorage），否则开场丢三团进来
	if ( ! restoreScene() ) {

		createClay( - 0.9, 3.0, 0.2, 0 );
		createClay( 0.1, 3.8, - 0.4, 4 );
		createClay( 0.9, 4.6, 0.4, 2 );

	}
	sceneDirty = false; // 刚恢复/开场的内容不算“用户改动”

	// 自动存档：改动后最多 3 秒落盘（后台被节流也无妨，切后台/关页时会立即存）
	setInterval( () => { if ( sceneDirty ) saveScene(); }, 3000 );
	window.addEventListener( 'pagehide', () => { commitTentative(); saveScene(); } );

	renderer.setAnimationLoop( animate );

	window.addEventListener( 'resize', () => {

		frameCamera();
		renderer.setSize( innerWidth, innerHeight );

	} );

}

// 让黏土盘在任何宽高比下都完整入画：竖屏时抬高机位、加大 FOV、拉远
function frameCamera() {

	// 页面可能在 0 尺寸容器里初始化（隐藏的预览面板等），兜住 NaN
	const aspect = Math.max( 1, innerWidth ) / Math.max( 1, innerHeight );
	const portrait = THREE.MathUtils.clamp( ( 1.05 - aspect ) / 0.6, 0, 1 );

	camera.aspect = aspect;
	camera.fov = 40 + portrait * 12;

	const halfV = Math.tan( THREE.MathUtils.degToRad( camera.fov / 2 ) );
	const halfH = halfV * aspect;
	const d = Math.max( 3.9 / halfH, 3.4 / halfV, 11 );

	_v.set( 0, 0.55 + portrait * 0.28, 0.835 - portrait * 0.25 ).normalize().multiplyScalar( d );
	boardCamPos.copy( _v ); // 供工坊相机混合用
	camera.position.copy( _v );
	camera.updateProjectionMatrix();
	camera.lookAt( 0, 0.7, 0 );

	// 雾距离跟着机位走，否则拉远后场景整体没入雾中
	if ( scene && scene.fog ) {

		scene.fog.near = d * 1.15;
		scene.fog.far = d * 2.3;

	}

}

// ---------- 黏土 / 眼睛的创建与销毁 ----------

function clayCount() {

	return balls.reduce( ( n, r ) => n + ( r.kind === 'clay' ? 1 : 0 ), 0 );

}

function decorCount() {

	return balls.reduce( ( n, r ) => n + ( r.kind !== 'clay' ? 1 : 0 ), 0 );

}

function pickRadiusOf( rec ) {

	return rec.kind === 'clay' ? FORMS[ rec.form ].pickR * rec.k : Math.max( rec.r * 1.6, 0.3 );

}

function stickRadiusOf( rec ) {

	return rec.kind === 'clay' ? FORMS[ rec.form ].stickR * rec.k : rec.r;

}

// metaball 强度：让等值面（isolation）恰好出现在期望的视觉半径处
function strengthFor( rVis ) {

	const rn = rVis / ( 2 * FIELD_S );
	return rn * rn * ( effect.isolation + SUBTRACT );

}

function createBallBody( x, y, z, radius, friction, restitution ) {

	const bd = b3.b3DefaultBodyDef();
	bd.type = b3.b3BodyType.b3_dynamicBody;
	bd.position = { x, y, z };
	const body = b3.b3CreateBody( world, bd );
	const sd = b3.b3DefaultShapeDef();
	sd.baseMaterial.friction = friction;
	sd.baseMaterial.restitution = restitution;
	const shape = b3.b3CreateSphereShape( body, sd, { center: { x: 0, y: 0, z: 0 }, radius } );
	b3.b3Body_SetLinearDamping( body, 0.3 );
	b3.b3Body_SetAngularDamping( body, 0.6 );
	return { body, shape };

}

function createClay( x, y, z, colorIndex, vel, kOverride ) {

	if ( clayCount() >= MAX_CLAY ) { shakePalette(); return null; }

	const k = kOverride !== undefined ? kOverride : SIZES[ sizeIndex ];
	const { body, shape } = createBallBody( x, y, z, CLAY_R * k, 0.9, 0.05 );
	if ( vel ) b3.b3Body_SetLinearVelocity( body, vel );

	const rec = {
		id: nextId ++,
		kind: 'clay',
		body,
		shape,
		form: 0,
		k,
		ci: colorIndex,
		frozen: false,
		slowTicks: 0,
		squash: 0,
		prevVy: 0,
		bornAt: performance.now(),
		dents: [],
		r: CLAY_R * k,
		color: new THREE.Color( CLAY_COLORS[ colorIndex ] ),
		mesh: null,
		alive: true,
	};
	balls.push( rec );
	markDirty();
	plop();
	return rec;

}

// 🐍 软链：几节小球用球关节串起来，软的，可以甩、可以搭在别的黏土上
function createChain( x, z, colorIndex, kBase ) {

	const k = ( kBase !== undefined ? kBase : SIZES[ sizeIndex ] ) * CHAIN_K;
	const spacing = CLAY_R * k * 2.05;
	const segs = [];
	for ( let i = 0; i < CHAIN_SEGS; i ++ ) {

		const rec = createClay( x + ( i - ( CHAIN_SEGS - 1 ) / 2 ) * spacing, 3 + i * 0.03, z, colorIndex, null, k );
		if ( ! rec ) break;
		segs.push( rec );

	}

	// 链节间用球关节（柔性）；记进 weldedKeys 防止 stickyPass 把链节焊死
	for ( let i = 0; i + 1 < segs.length; i ++ ) {

		if ( ! weldRaw( segs[ i ], segs[ i + 1 ], true ) ) break;

	}
	return segs;

}

function createDecor( kind, x, y, z ) {

	if ( decorCount() >= MAX_DECOR ) { shakePalette(); return null; }

	const spec = DECOR[ kind ];
	const { body, shape } = createBallBody( x, y, z, spec.r, 0.8, 0.1 );

	const mesh = decorBuilders[ kind ]();
	scene.add( mesh );

	const rec = { id: nextId ++, kind, body, shape, r: spec.r, color: null, mesh, alive: true, frozen: false, slowTicks: 0, bornAt: performance.now(), popAt: 0, nextBlink: performance.now() + 1200 + Math.random() * 3000, blinkUntil: 0 };
	balls.push( rec );
	markDirty();
	plop();
	return rec;

}

// 按 rec.form + rec.k 构建物理形状（调用前先 destroy 旧的）
function buildShape( rec ) {

	const sd = b3.b3DefaultShapeDef();
	sd.baseMaterial.friction = 0.9;
	sd.baseMaterial.restitution = 0.05;
	const k = rec.k;

	if ( rec.form === 1 ) {

		// 手工构居中的圆盘 hull：b3CreateCylinder 生成的 hull 底面在原点（y ∈ [0, h]），不居中
		const pts = [];
		for ( let i = 0; i < 12; i ++ ) {

			const a = ( i / 12 ) * Math.PI * 2;
			const px = Math.cos( a ) * 0.55 * k, pz = Math.sin( a ) * 0.55 * k;
			pts.push( px, - 0.18 * k, pz, px, 0.18 * k, pz );

		}
		const hull = b3.b3CreateHull( new Float32Array( pts ) );
		if ( ! hull ) throw new Error( 'disc hull failed' );
		const shape = b3.b3CreateHullShape( rec.body, sd, hull );
		hull.delete();
		return shape;

	}
	if ( rec.form === 2 ) {

		return b3.b3CreateCapsuleShape( rec.body, sd, {
			center1: { x: - 0.42 * k, y: 0, z: 0 },
			center2: { x: 0.42 * k, y: 0, z: 0 },
			radius: 0.34 * k,
		} );

	}
	if ( rec.form === 3 ) return b3.b3CreateBoxShape( rec.body, sd, 0.42 * k, 0.3 * k, 0.42 * k );
	return b3.b3CreateSphereShape( rec.body, sd, { center: { x: 0, y: 0, z: 0 }, radius: CLAY_R * k } );

}

// 按住黏土变形：圆球 → 压扁 → 搓长 → 方砖。物理形状同步替换，metaball 子球在 rebuildClay 里按形态渲染
function setForm( rec, form, quiet ) {

	if ( rec.kind !== 'clay' || form === rec.form || ! rec.alive ) return;

	unfreeze( rec );
	detach( rec, true ); // 变形前先拆开，冷却结束后原地重新黏上

	try {

		b3.b3DestroyShape( rec.shape, true );
		rec.form = form;
		rec.shape = buildShape( rec );

	} catch ( err ) {

		// 形状 API 出问题时退回圆球，别让 body 裸奔
		console.warn( 'setForm failed, fallback to ball:', err );
		rec.form = 0;
		rec.shape = buildShape( rec );

	}

	rec.dents.length = 0; // 重新揉过，旧坑抹平
	b3.b3Body_SetAwake( rec.body, true );
	markDirty();
	if ( ! quiet ) squish();

}

// 双指捏合：把一件黏土整体缩放到新的大小系数（保留形态与凹坑，凹坑随比例走）
function applyScale( rec, newK ) {

	if ( rec.kind !== 'clay' || ! rec.alive ) return;

	unfreeze( rec );
	const ratio = newK / rec.k;
	rec.k = newK;
	rec.r = CLAY_R * newK;
	for ( const d of rec.dents ) {

		d[ 0 ] *= ratio; d[ 1 ] *= ratio; d[ 2 ] *= ratio;

	}

	try {

		b3.b3DestroyShape( rec.shape, true );
		rec.shape = buildShape( rec );

	} catch ( err ) {

		console.warn( 'applyScale failed:', err );

	}

	b3.b3Body_SetAwake( rec.body, true );
	markDirty();

}

// 世界点 → 刚体局部点
function worldToLocal( rec, wp, out ) {

	const p = b3.b3Body_GetPosition( rec.body );
	const q = b3.b3Body_GetRotation( rec.body );
	_q.set( q.v.x, q.v.y, q.v.z, q.s ).invert();
	return out.set( wp.x - p.x, wp.y - p.y, wp.z - p.z ).applyQuaternion( _q );

}

// 把局部点压到该形态的表面壳内侧一点（负球咬进等值面内才有可见效果；鼓包也从壳上起步才不悬空）
function clampToShell( rec, lp ) {

	const k = rec.k;
	if ( rec.form === 1 ) {

		// 圆盘：厚度方向压到皮下，径向不出边
		lp.y = THREE.MathUtils.clamp( lp.y, - 0.18 * k, 0.18 * k );
		const r = Math.hypot( lp.x, lp.z );
		if ( r > 0.5 * k ) { const s = 0.5 * k / r; lp.x *= s; lp.z *= s; }

	} else if ( rec.form === 2 ) {

		// 香肠：轴向夹在两端内，径向压到皮下
		lp.x = THREE.MathUtils.clamp( lp.x, - 0.7 * k, 0.7 * k );
		const r = Math.hypot( lp.y, lp.z );
		if ( r > 0.28 * k ) { const s = 0.28 * k / r; lp.y *= s; lp.z *= s; }

	} else if ( rec.form === 3 ) {

		// 方砖：各轴分别夹到皮下
		lp.x = THREE.MathUtils.clamp( lp.x, - 0.38 * k, 0.38 * k );
		lp.y = THREE.MathUtils.clamp( lp.y, - 0.22 * k, 0.22 * k );
		lp.z = THREE.MathUtils.clamp( lp.z, - 0.38 * k, 0.38 * k );

	} else {

		const len = lp.length();
		if ( len > 0.001 ) lp.multiplyScalar( Math.max( 0, len - 0.14 * k ) / len );

	}
	return lp;

}

// 在世界点 wp 处给黏土捏一个坑（存局部坐标，跟着刚体转）
function addDentAt( rec, wp ) {

	const lp = clampToShell( rec, worldToLocal( rec, wp, new THREE.Vector3() ) );
	rec.dents.push( [ lp.x, lp.y, lp.z, - 1 ] );
	if ( rec.dents.length > MAX_DENTS ) rec.dents.shift();
	markDirty();
	squish();

}

// 从表面往外拉：先贴到表面壳再沿局部径向外推，鼓出的包紧贴本体不悬空
function addBumpAt( rec, wp ) {

	const lp = clampToShell( rec, worldToLocal( rec, wp, new THREE.Vector3() ) );
	const len = lp.length();
	if ( len > 0.001 ) lp.multiplyScalar( ( len + 0.22 * rec.k ) / len );
	rec.dents.push( [ lp.x, lp.y, lp.z, 1 ] );
	if ( rec.dents.length > MAX_DENTS ) rec.dents.shift();
	markDirty();
	boing();

}

// 🖌 上色：像按上一小块彩泥——正强度小 metaball 抹在表面，颜色可与本体不同
const DAB_R = [ 0.1, 0.15, 0.26 ]; // 色块三档：点 / 块 / 大补丁（脸、肚皮）

function addDabAt( rec, wp, ci, sz ) {

	const lp = clampToShell( rec, worldToLocal( rec, wp, new THREE.Vector3() ) );
	const len = lp.length();
	if ( len > 0.001 ) lp.multiplyScalar( ( len + 0.1 * rec.k ) / len );
	rec.dents.push( [ lp.x, lp.y, lp.z, 2, ci, sz === undefined ? 1 : sz ] );
	if ( rec.dents.length > MAX_DENTS ) rec.dents.shift();
	markDirty();
	dabTick();

}

// 捏捏模式下取指针射线与黏土“表面”的近似交点（用视觉包围球代替等值面）
function kneadHit( rec, out ) {

	const p = b3.b3Body_GetPosition( rec.body );
	_sphere.center.set( p.x, p.y, p.z );
	_sphere.radius = ( rec.form === 0 ? CLAY_R_VIS : FORMS[ rec.form ].pickR * 0.85 ) * rec.k;
	return raycaster.ray.intersectSphere( _sphere, out );

}

// 移除单件（销毁刚体与网格，摘出列表）
function removePiece( rec ) {

	rec.alive = false;
	detach( rec, true );
	b3.b3DestroyBody( rec.body );
	if ( rec.mesh ) scene.remove( rec.mesh );
	const i = balls.indexOf( rec );
	if ( i >= 0 ) balls.splice( i, 1 );
	markDirty();

}

// ✂️ 剪刀：普通件一分为二（同形态同色、各缩八成），软链剪断这一节两侧的关节
function cutPiece( rec ) {

	if ( rec.kind !== 'clay' || ! rec.alive ) return;

	if ( isChainSeg( rec ) ) {

		unfreeze( rec );
		detach( rec );
		snip();
		return;

	}

	const k2 = rec.k * 0.8;
	if ( k2 < 0.4 ) { shakePalette(); squish(); return; } // 太小剪不动

	unfreeze( rec );
	const p = b3.b3Body_GetPosition( rec.body );
	// 沿屏幕水平方向分开两半
	_v.setFromMatrixColumn( camera.matrixWorld, 0 );
	_v.y = 0;
	_v.normalize();
	const form = rec.form, ci = rec.ci || 0;
	// 分开的距离要超过黏住阈值，否则冷却一过两半又黏回去
	const off = FORMS[ form ].stickR * k2 * 1.06 + 0.12;
	const dx = _v.x, dz = _v.z;
	removePiece( rec );
	const mk = ( s ) => {

		const r = createClay( p.x + dx * off * s, p.y + 0.06, p.z + dz * off * s, ci, null, k2 );
		if ( r && form ) setForm( r, form, true );
		return r;

	};
	const a = mk( - 1 ), b = mk( 1 );
	if ( a && b ) noStickUntil.set( weldKey( a.id, b.id ), performance.now() + DETACH_COOLDOWN );
	snip();

}

function clearAll() {

	drag = null;
	if ( tentative ) { clearTimeout( tentative.timer ); tentative = null; hideConfirmBar(); resetHint(); }
	hideSnapRing();
	lastTap = { rec: null, t: 0 };
	if ( pendingHop ) { clearTimeout( pendingHop.timer ); pendingHop = null; }
	for ( const j of joints ) b3.b3DestroyJoint( j.joint, false );
	joints = [];
	weldedKeys.clear();
	noStickUntil.clear();
	for ( const rec of balls ) {

		rec.alive = false;
		b3.b3DestroyBody( rec.body );
		if ( rec.mesh ) scene.remove( rec.mesh );

	}
	balls = [];
	markDirty();
	pop();
	saveScene(); // 清空是明确意图，立即落盘，别让刷新“复活”作品

}

// ---------- 保存 / 分享：场景序列化进 URL hash（当前网址即分享链接）+ localStorage 自动存档 ----------

function r3( x ) {

	return Math.round( x * 100 ) / 100;

}

function serializeScene() {

	const idx = new Map( balls.map( ( r, i ) => [ r.id, i ] ) );
	const out = {
		v: 1,
		p: balls.map( ( r ) => {

			const p = b3.b3Body_GetPosition( r.body );
			const o = { t: r.kind, p: [ r3( p.x ), r3( p.y ), r3( p.z ) ] };
			if ( r.kind === 'figure' ) o.w = r.figData;
			// 无坑无形的素球旋转不可见，省掉四元数给 hash 瘦身
			const plain = r.kind === 'clay' && r.form === 0 && r.dents.length === 0;
			if ( ! plain ) {

				const q = b3.b3Body_GetRotation( r.body );
				o.q = [ r3( q.v.x ), r3( q.v.y ), r3( q.v.z ), r3( q.s ) ];

			}
			if ( r.kind === 'clay' ) {

				o.f = THREE.MathUtils.clamp( r.form | 0, 0, FORMS.length - 1 );
				o.k = r3( r.k );
				o.c = Math.max( 0, CLAY_COLORS.indexOf( r.color.getHex() ) );
				if ( r.dents.length ) o.d = r.dents.map( ( d ) => [ r3( d[ 0 ] ), r3( d[ 1 ] ), r3( d[ 2 ] ), d[ 3 ] === 2 ? 2 : ( d[ 3 ] === 1 ? 1 : - 1 ), d[ 4 ] | 0, d[ 5 ] === undefined ? 1 : d[ 5 ] | 0 ] );

			}
			return o;

		} ),
		j: joints
			.map( ( j ) => [ idx.get( j.aId ), idx.get( j.bId ), j.chain ? 1 : 0 ] )
			.filter( ( a ) => a[ 0 ] !== undefined && a[ 1 ] !== undefined ),
	};
	// 工坊里的半成品也随存档走（刷新回来接着捏）
	const wd = wsFigData( workshop || wsKeep );
	if ( wd ) out.w = wd;
	return out;

}

function loadScene( data ) {

	try {

		if ( ! data || data.v !== 1 || ! Array.isArray( data.p ) || data.p.length === 0 ) return false;

		// 静默清场（不放音效——加载时 AudioContext 还没解锁，本来也无声）
		for ( const j of joints ) b3.b3DestroyJoint( j.joint, false );
		joints = [];
		weldedKeys.clear();
		noStickUntil.clear();
		for ( const rec of balls ) {

			rec.alive = false;
			b3.b3DestroyBody( rec.body );
			if ( rec.mesh ) scene.remove( rec.mesh );

		}
		balls = [];

		// 存档可能来自他人链接甚至手改：所有数值必须有限且夹进合法域，否则 NaN/Infinity 会毒化物理与渲染
		const num = ( v, d ) => ( Number.isFinite( + v ) ? + v : d );
		const made = [];
		for ( const o of data.p.slice( 0, MAX_CLAY + MAX_DECOR ) ) {

			if ( ! o || ! Array.isArray( o.p ) ) { made.push( null ); continue; }
			let rec = null;
			const px = THREE.MathUtils.clamp( num( o.p[ 0 ], 0 ), - BOARD_HALF, BOARD_HALF );
			const py = THREE.MathUtils.clamp( num( o.p[ 1 ], 1 ), 0.15, 6 );
			const pz = THREE.MathUtils.clamp( num( o.p[ 2 ], 0 ), - BOARD_HALF, BOARD_HALF );
			if ( o.t === 'clay' ) {

				const k = THREE.MathUtils.clamp( num( o.k, 1 ), 0.4, 2 );
				rec = createClay( px, py, pz, THREE.MathUtils.clamp( num( o.c, 0 ) | 0, 0, CLAY_COLORS.length - 1 ), null, k );
				const form = THREE.MathUtils.clamp( num( o.f, 0 ) | 0, 0, FORMS.length - 1 );
				if ( rec && form ) setForm( rec, form, true );
				if ( rec && Array.isArray( o.d ) ) {

					rec.dents = o.d.filter( Array.isArray ).slice( 0, MAX_DENTS )
						.map( ( d ) => [ num( d[ 0 ], 0 ), num( d[ 1 ], 0 ), num( d[ 2 ], 0 ),
							( d[ 3 ] === 1 || d[ 3 ] === 2 ) ? d[ 3 ] : - 1,
							THREE.MathUtils.clamp( num( d[ 4 ], 0 ) | 0, 0, CLAY_COLORS.length - 1 ),
							THREE.MathUtils.clamp( num( d[ 5 ], 1 ) | 0, 0, 2 ) ] );

				}

			} else if ( o.t === 'figure' ) {

				// 初始 baseY 随便给，紧接着的通用 SetTransform 会摆到存档位置
				rec = o.w ? createFigure( o.w, px, py, pz ) : null;

			} else if ( DECOR[ o.t ] ) {

				rec = createDecor( o.t, px, py, pz );

			}

			if ( rec ) {

				const qa = Array.isArray( o.q ) ? o.q : [ 0, 0, 0, 1 ];
				_q.set( num( qa[ 0 ], 0 ), num( qa[ 1 ], 0 ), num( qa[ 2 ], 0 ), num( qa[ 3 ], 1 ) );
				if ( _q.lengthSq() < 1e-6 ) _q.identity();
				else _q.normalize();
				b3.b3Body_SetTransform( rec.body, { x: px, y: py, z: pz }, { v: { x: _q.x, y: _q.y, z: _q.z }, s: _q.w } );
				b3.b3Body_SetLinearVelocity( rec.body, { x: 0, y: 0, z: 0 } );
				b3.b3Body_SetAngularVelocity( rec.body, { x: 0, y: 0, z: 0 } );

			}
			made.push( rec );

		}

		for ( const a of ( Array.isArray( data.j ) ? data.j : [] ) ) {

			const A = made[ a[ 0 ] ], B = made[ a[ 1 ] ];
			if ( A && B && ! weldedKeys.has( weldKey( A.id, B.id ) ) ) weldRaw( A, B, a[ 2 ] === 1 );

		}

		markDirty();
		return balls.length > 0;

	} catch ( err ) {

		console.warn( 'load scene failed:', err );
		return false;

	}

}

let sceneDirty = false;
let userTouched = false;         // 动过手才允许覆盖 localStorage 存档（防止打开分享链接就冲掉自己的作品）

function saveScene() {

	// 表演期间不落盘：demo 中途刷新恢复的是开演前的作品
	if ( ! world || demoRun ) return;
	sceneDirty = false;

	let str;
	try {

		str = JSON.stringify( serializeScene() );

	} catch ( err ) { return; }

	// 当前网址即分享链接：把作品编码进 hash（replaceState 不产生历史记录）
	try {

		const b64 = btoa( str ).replace( /\+/g, '-' ).replace( /\//g, '_' ).replace( /=+$/, '' );
		const hasContent = balls.length > 0 || wsFigData( workshop || wsKeep );
		history.replaceState( null, '', hasContent ? '#s=' + b64 : location.pathname + location.search );

	} catch ( err ) {}

	if ( userTouched ) {

		try { localStorage.setItem( 'clay-scene', str ); } catch ( err ) { /* 隐私模式/配额满 */ }

	}

}

let wsSavedData = null;          // 存档里的工坊半成品配方，进工坊时还原

function restoreScene() {

	const m = location.hash.match( /#s=([A-Za-z0-9_-]+)/ );
	if ( m ) {

		try {

			const data = JSON.parse( atob( m[ 1 ].replace( /-/g, '+' ).replace( /_/g, '/' ) ) );
			if ( data && data.w ) wsSavedData = data.w;
			if ( loadScene( data ) ) return true;

		} catch ( err ) { /* hash 不合法就走下一级 */ }

	}
	try {

		const str = localStorage.getItem( 'clay-scene' );
		if ( str ) {

			const data = JSON.parse( str );
			if ( data && data.w ) wsSavedData = data.w;
			return loadScene( data );

		}

	} catch ( err ) {}
	return false;

}

// ---------- 黏住 / 拆开 ----------

function weldKey( a, b ) {

	return a < b ? a + '|' + b : b + '|' + a;

}

// 把世界系中的锚点（mid、单位朝向）换算进刚体局部系
function localFrame( p, q, mid ) {

	const qi = new THREE.Quaternion( q.v.x, q.v.y, q.v.z, q.s ).invert();
	const lp = new THREE.Vector3( mid.x - p.x, mid.y - p.y, mid.z - p.z ).applyQuaternion( qi );
	return { p: { x: lp.x, y: lp.y, z: lp.z }, q: { v: { x: qi.x, y: qi.y, z: qi.z }, s: qi.w } };

}

// 按当前位姿在两件之间建关节（chain=true 用球关节，柔性；否则刚性焊接）
function weldRaw( a, b, chain ) {

	try {

		const pa = b3.b3Body_GetPosition( a.body );
		const pb = b3.b3Body_GetPosition( b.body );
		const qa = b3.b3Body_GetRotation( a.body );
		const qb = b3.b3Body_GetRotation( b.body );
		const mid = { x: ( pa.x + pb.x ) / 2, y: ( pa.y + pb.y ) / 2, z: ( pa.z + pb.z ) / 2 };

		const def = chain ? b3.b3DefaultSphericalJointDef() : b3.b3DefaultWeldJointDef();
		def.base.bodyIdA = a.body;
		def.base.bodyIdB = b.body;
		def.base.localFrameA = localFrame( pa, qa, mid );
		def.base.localFrameB = localFrame( pb, qb, mid );

		const joint = chain ? b3.b3CreateSphericalJoint( world, def ) : b3.b3CreateWeldJoint( world, def );
		joints.push( { joint, aId: a.id, bId: b.id, key: weldKey( a.id, b.id ), chain: !! chain } );
		weldedKeys.add( weldKey( a.id, b.id ) );
		return true;

	} catch ( err ) {

		// 关节 API 不可用时退化为普通碰撞，游戏仍可玩
		stickyEnabled = false;
		console.warn( 'joint failed, sticky disabled:', err );
		return false;

	}

}

function weld( a, b, key ) {

	// 贴件（眼/嘴/帽）焊上去之前：+Z 转向外侧；圆球黏土还把它推到视觉表面之外，避免被 metaball 吞没。
	// 只有真贴件才转向——手办这类大件按原姿态焊
	const dec = DECOR[ a.kind ] ? a : ( DECOR[ b.kind ] ? b : null );
	if ( dec ) {

		const other = dec === a ? b : a;
		const pe = b3.b3Body_GetPosition( dec.body );
		const po = b3.b3Body_GetPosition( other.body );
		_v.set( pe.x - po.x, pe.y - po.y, pe.z - po.z );
		if ( _v.lengthSq() > 1e-6 ) {

			_v.normalize();
			_q.setFromUnitVectors( new THREE.Vector3( 0, 0, 1 ), _v );
			let pos = pe;
			if ( other.form === 0 ) {

				const dist = CLAY_R_VIS * ( other.k || 1 ) + DECOR[ dec.kind ].out;
				pos = { x: po.x + _v.x * dist, y: po.y + _v.y * dist, z: po.z + _v.z * dist };

			}
			b3.b3Body_SetTransform( dec.body, pos, { v: { x: _q.x, y: _q.y, z: _q.z }, s: _q.w } );
			b3.b3Body_SetAngularVelocity( dec.body, { x: 0, y: 0, z: 0 } );

		}

	}

	if ( weldRaw( a, b, false ) ) {

		if ( a.kind === 'clay' ) a.squash = Math.max( a.squash, 0.5 );
		if ( b.kind === 'clay' ) b.squash = Math.max( b.squash, 0.5 );
		if ( dec ) dec.popAt = performance.now();
		markDirty();
		squish();

	}

}

function detach( rec, quiet ) {

	unfreeze( rec );
	let removed = false;
	joints = joints.filter( ( j ) => {

		if ( j.aId !== rec.id && j.bId !== rec.id ) return true;
		b3.b3DestroyJoint( j.joint, true );
		weldedKeys.delete( j.key );
		noStickUntil.set( j.key, performance.now() + DETACH_COOLDOWN );
		removed = true;
		return false;

	} );
	if ( removed && ! quiet ) {

		b3.b3Body_SetAwake( rec.body, true );
		// 轻轻弹开一点，让“拆开了”看得见
		const m = b3.b3Body_GetMass( rec.body );
		b3.b3Body_ApplyLinearImpulseToCenter( rec.body, { x: 0, y: m * 2.5, z: 0 }, true );
		pop();

	}

}

// ---------- 贴件精确放置：拖着贴件沿黏土表面滑动，松手后 ✓ 贴好 / ↺ 放回 ----------

// 射线与所有黏土“视觉表面”（形态子球集合，按 k 缩放）求最近交点。
// 命中返回 { host, pos, normal }：pos 在子球表面上，normal 由子球心指向命中点
function surfaceHit() {

	let best = null, bestT = Infinity;
	for ( const rec of balls ) {

		if ( ! rec.alive || rec.kind !== 'clay' ) continue;
		const p = b3.b3Body_GetPosition( rec.body );
		const form = FORMS[ rec.form ];
		const multi = form.sub.length > 1;
		if ( multi ) {

			const q = b3.b3Body_GetRotation( rec.body );
			_q.set( q.v.x, q.v.y, q.v.z, q.s );

		}
		for ( const sub of form.sub ) {

			if ( multi ) _v2.set( sub.o[ 0 ], sub.o[ 1 ], sub.o[ 2 ] ).multiplyScalar( rec.k ).applyQuaternion( _q );
			else _v2.set( 0, 0, 0 );
			_sphere.center.set( p.x + _v2.x, p.y + _v2.y, p.z + _v2.z );
			_sphere.radius = sub.r * rec.k;
			if ( raycaster.ray.intersectSphere( _sphere, _v ) ) {

				const t = _v.distanceTo( raycaster.ray.origin );
				if ( t < bestT ) {

					bestT = t;
					best = { host: rec, pos: _v.clone(), normal: _v.clone().sub( _sphere.center ).normalize() };

				}

			}

		}

	}
	return best;

}

function showSnapRing( hit ) {

	if ( ! snapRing ) {

		snapRing = new THREE.Mesh(
			new THREE.RingGeometry( 0.17, 0.22, 24 ),
			new THREE.MeshBasicMaterial( { color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide } )
		);
		snapRing.renderOrder = 2;
		scene.add( snapRing );

	}
	snapRing.position.copy( hit.pos ).addScaledVector( hit.normal, 0.02 );
	snapRing.quaternion.setFromUnitVectors( Z_OUT, hit.normal );
	snapRing.visible = true;

}

function hideSnapRing() {

	if ( snapRing ) snapRing.visible = false;

}

// 确认气泡跟着贴件的屏幕投影走（贴件此刻是静态的，摆一次即可）
function showConfirmBar( rec ) {

	if ( ! confirmBarEl ) return;
	const p = b3.b3Body_GetPosition( rec.body );
	_v.set( p.x, p.y, p.z ).project( camera );
	const sx = ( _v.x * 0.5 + 0.5 ) * innerWidth;
	const sy = ( - _v.y * 0.5 + 0.5 ) * innerHeight;
	confirmBarEl.style.left = Math.min( Math.max( sx, 84 ), innerWidth - 84 ) + 'px';
	confirmBarEl.style.top = Math.min( Math.max( sy - 96, 16 ), innerHeight - 100 ) + 'px';
	confirmBarEl.classList.remove( 'hidden' );

}

function hideConfirmBar() {

	if ( confirmBarEl ) confirmBarEl.classList.add( 'hidden' );

}

// 松手进入待确认：贴件先原地钉住（static），✓ 才真正焊上，↺ 放回原处/收回
function enterTentative( rec, s, host ) {

	b3.b3Body_SetTransform( rec.body,
		{ x: drag.target.x, y: drag.target.y, z: drag.target.z },
		{ v: { x: drag.targetQuat.x, y: drag.targetQuat.y, z: drag.targetQuat.z }, s: drag.targetQuat.w } );
	b3.b3Body_SetLinearVelocity( rec.body, { x: 0, y: 0, z: 0 } );
	b3.b3Body_SetAngularVelocity( rec.body, { x: 0, y: 0, z: 0 } );
	b3.b3Body_SetType( rec.body, b3.b3BodyType.b3_staticBody );
	rec.frozen = true;
	tentative = {
		rec,
		host,
		isNew: !! s.isNewDecor,
		restore: s.restore || null,
		timer: setTimeout( () => commitTentative(), 6000 ), // 不点也没关系：几秒后自动贴好
	};
	hideSnapRing();
	showConfirmBar( rec );
	markDirty();
	setHint( '位置好了点 ✓ · 想换地方点 ↺' );

}

function commitTentative() {

	if ( ! tentative ) return;
	const t = tentative;
	tentative = null;
	clearTimeout( t.timer );
	hideConfirmBar();
	resetHint();
	if ( ! t.rec.alive ) return;

	// 恢复动态再焊接：焊到 static 贴件上会把整个宿主钉死在原地
	b3.b3Body_SetType( t.rec.body, b3.b3BodyType.b3_dynamicBody );
	t.rec.frozen = false;
	clearCooldownsFor( t.rec.id );
	if ( t.host && t.host.alive && ! weldedKeys.has( weldKey( t.rec.id, t.host.id ) ) ) {

		if ( weldRaw( t.rec, t.host, false ) ) {

			t.rec.popAt = performance.now();
			squish();

		}

	}
	for ( const r of connectedOf( t.rec, true ) ) r.justPlaced = stepCount;
	b3.b3Body_SetAwake( t.rec.body, true );
	markDirty();

}

function cancelTentative() {

	if ( ! tentative ) return;
	const t = tentative;
	tentative = null;
	clearTimeout( t.timer );
	hideConfirmBar();
	resetHint();
	if ( ! t.rec.alive ) return;

	if ( t.isNew || ! t.restore ) {

		removePiece( t.rec );
		pop();

	} else {

		// 挪动已有贴件后反悔：放回原位并重新焊回原宿主
		b3.b3Body_SetType( t.rec.body, b3.b3BodyType.b3_dynamicBody );
		t.rec.frozen = false;
		b3.b3Body_SetTransform( t.rec.body, t.restore.p, t.restore.q );
		b3.b3Body_SetLinearVelocity( t.rec.body, { x: 0, y: 0, z: 0 } );
		b3.b3Body_SetAngularVelocity( t.rec.body, { x: 0, y: 0, z: 0 } );
		clearCooldownsFor( t.rec.id );
		for ( const h of t.restore.hosts ) {

			if ( h.alive && ! weldedKeys.has( weldKey( t.rec.id, h.id ) ) ) weldRaw( t.rec, h, false );

		}
		for ( const r of connectedOf( t.rec, true ) ) r.justPlaced = stepCount;
		markDirty();
		pop();

	}

}

// 每隔几步做一次 O(n²) 邻近检查：慢速贴着的黏土互相焊住（球数上限很小，代价可忽略）
function stickyPass() {

	if ( ! stickyEnabled ) return;

	for ( let i = 0; i < balls.length; i ++ ) {

		for ( let j = i + 1; j < balls.length; j ++ ) {

			const a = balls[ i ], b = balls[ j ];
			if ( a.kind !== 'clay' && b.kind !== 'clay' ) continue; // 贴件之间不互黏
			// 手里的件不吸附：先摆到位，松手才黏（否则拖着穿过别的作品会被半路焊住）
			if ( drag && ( a === drag.rec || b === drag.rec ) ) continue;
			// 待确认的贴件也不自动黏：↺ 还能干干净净地放回去
			if ( tentative && ( a === tentative.rec || b === tentative.rec ) ) continue;

			const key = weldKey( a.id, b.id );
			if ( weldedKeys.has( key ) ) continue;
			const cooldown = noStickUntil.get( key );
			if ( cooldown !== undefined ) {

				if ( performance.now() < cooldown ) continue;
				noStickUntil.delete( key );

			}

			const pa = b3.b3Body_GetPosition( a.body );
			const pb = b3.b3Body_GetPosition( b.body );
			const dx = pa.x - pb.x, dy = pa.y - pb.y, dz = pa.z - pb.z;
			const rr = ( stickRadiusOf( a ) + stickRadiusOf( b ) ) * 1.06;
			if ( dx * dx + dy * dy + dz * dz > rr * rr ) continue;

			const va = b3.b3Body_GetLinearVelocity( a.body );
			const vb = b3.b3Body_GetLinearVelocity( b.body );
			const rx = va.x - vb.x, ry = va.y - vb.y, rz = va.z - vb.z;
			const maxV = ( a.kind !== 'clay' || b.kind !== 'clay' ) ? DECOR_STICK_SPEED : STICK_SPEED;
			if ( rx * rx + ry * ry + rz * rz > maxV * maxV ) continue;

			weld( a, b, key );
			if ( ! stickyEnabled ) return;

		}

	}

}

// 物理炸飞 / 穿墙的兜底：掉出世界就放回盘中央
function rescuePass() {

	for ( const rec of balls ) {

		if ( rec.frozen ) continue;
		const p = b3.b3Body_GetPosition( rec.body );
		if ( p.y < - 2 || Math.hypot( p.x, p.z ) > BOARD_HALF + 0.8 ) {

			detach( rec );
			b3.b3Body_SetTransform( rec.body, { x: p.x * 0.2, y: 3, z: p.z * 0.2 }, { v: { x: 0, y: 0, z: 0 }, s: 1 } );
			b3.b3Body_SetLinearVelocity( rec.body, { x: 0, y: 0, z: 0 } );
			b3.b3Body_SetAngularVelocity( rec.body, { x: 0, y: 0, z: 0 } );
			markDirty();

		}

	}

}

// ---------- 拖拽（速度伺服，比运动学切换更好地兼容焊接群） ----------

// 沿关节求连通团。includeChains=false 时跳过软链（拖拽时链保持柔软）
function connectedOf( rec, includeChains ) {

	const seen = new Set( [ rec.id ] );
	const list = [ rec ];
	let changed = true;
	while ( changed ) {

		changed = false;
		for ( const j of joints ) {

			if ( ! includeChains && j.chain ) continue;
			const hasA = seen.has( j.aId ), hasB = seen.has( j.bId );
			if ( hasA === hasB ) continue;
			const otherId = hasA ? j.bId : j.aId;
			const other = balls.find( ( b ) => b.id === otherId );
			if ( other ) { seen.add( otherId ); list.push( other ); changed = true; }

		}

	}
	return list;

}

function clusterOf( rec ) {

	return connectedOf( rec, false );

}

// ---------- 定型：摆稳的黏土冻结成“雕像”，怎么歪都立得住；一碰又变软 ----------

const FREEZE_LIN2 = 0.5 * 0.5;   // 线速度平方阈值
const FREEZE_ANG2 = 1.0 * 1.0;   // 角速度平方阈值

function unfreeze( rec ) {

	if ( ! rec.frozen || ! rec.alive ) return;
	rec.frozen = false;
	rec.slowTicks = 0;
	b3.b3Body_SetType( rec.body, b3.b3BodyType.b3_dynamicBody );
	b3.b3Body_SetAwake( rec.body, true );

}

function unfreezeCluster( rec ) {

	for ( const r of connectedOf( rec, true ) ) unfreeze( r );

}

// 每 15 步跑一次：连续两次检查（约 0.5 秒）都低速的件转为静态。
// 头重脚轻的作品在倾倒加速前就被“定住”，这正是黏土“摆哪儿定哪儿”的手感
function freezePass() {

	const dragSet = drag ? new Set( connectedOf( drag.rec, true ).map( ( r ) => r.id ) ) : null;

	for ( const rec of balls ) {

		if ( rec.frozen || ! rec.alive ) continue;
		if ( dragSet && dragSet.has( rec.id ) ) { rec.slowTicks = 0; continue; }

		const v = b3.b3Body_GetLinearVelocity( rec.body );
		const w = b3.b3Body_GetAngularVelocity( rec.body );
		if ( v.x * v.x + v.y * v.y + v.z * v.z < FREEZE_LIN2
			&& w.x * w.x + w.y * w.y + w.z * w.z < FREEZE_ANG2 ) {

			// 刚放下的快速定型要避开“松手瞬间还没开始下落”的窗口（20 步后才生效，此时仍在空中的件速度已大）
			const sincePlaced = rec.justPlaced ? stepCount - rec.justPlaced : 1e9;
			const need = sincePlaced > 20 && sincePlaced < 140 ? 1 : 2;
			if ( ++ rec.slowTicks >= need ) {

				b3.b3Body_SetType( rec.body, b3.b3BodyType.b3_staticBody );
				rec.frozen = true;
				rec.slowTicks = 0;

			}

		} else {

			rec.slowTicks = 0;

		}

	}

}

// 堆叠的核心：抓着的件自动悬浮在手指下方最高支撑物之上（排除自己连着的整团）
function hoverSupport( d ) {

	const exclude = new Set( connectedOf( d.rec, true ).map( ( r ) => r.id ) );
	const cr = pickRadiusOf( d.rec );
	let top = 0, snap = null;
	for ( const rec of balls ) {

		if ( ! rec.alive || exclude.has( rec.id ) ) continue;
		const p = b3.b3Body_GetPosition( rec.body );
		const rr = pickRadiusOf( rec );
		const dx = p.x - d.target.x, dz = p.z - d.target.z;
		// 收紧触发：大半悬在支撑物正上方才抬升——侧面靠近保持原高度，才能把件贴到别人脸上
		const reach = rr * 0.55 + cr * 0.3;
		if ( dx * dx + dz * dz > reach * reach ) continue;
		const t = p.y + rr;
		if ( t > top ) {

			top = t;
			// 双方都是黏土且接近轴线时，轻微向支撑中心吸附，塔搭得直
			snap = ( rec.kind === 'clay' && d.rec.kind === 'clay' && dx * dx + dz * dz < 0.2 ) ? { x: p.x, z: p.z } : null;

		}

	}
	return { h: Math.min( Math.max( LIFT_Y, top + cr + 0.1 ), 4.2 ), snap };

}

function dragControl() {

	if ( ! drag || ! drag.rec.alive ) return;

	// 表面吸附中的贴件目标即落点，不做悬浮抬升
	if ( ! drag.surface ) {

		// 悬浮高度随支撑物平滑升降；对中吸附让堆叠不歪
		const sup = hoverSupport( drag );
		drag.target.y += ( sup.h - drag.target.y ) * 0.22;
		if ( sup.snap ) {

			drag.target.x += ( sup.snap.x - drag.target.x ) * 0.18;
			drag.target.z += ( sup.snap.z - drag.target.z ) * 0.18;

		}

	}

	const q = drag.targetQuat;
	b3.b3Body_SetTargetTransform( drag.rec.body, {
		p: { x: drag.target.x, y: drag.target.y, z: drag.target.z },
		q: { v: { x: q.x, y: q.y, z: q.z }, s: q.w },
	}, STEP, true );

	// SetTargetTransform 的位置部分很准，但 0.0.2 里旋转不跟：用误差四元数自己驱动角速度
	const cur = b3.b3Body_GetRotation( drag.rec.body );
	_q.set( cur.v.x, cur.v.y, cur.v.z, cur.s ).invert().premultiply( q );
	if ( _q.w < 0 ) { _q.x *= - 1; _q.y *= - 1; _q.z *= - 1; _q.w *= - 1; }
	const ang = 2 * Math.acos( Math.min( 1, _q.w ) );
	const halfSin = Math.sqrt( Math.max( 0, 1 - _q.w * _q.w ) );
	if ( ang > 0.02 && halfSin > 1e-4 ) {

		const f = Math.min( ang * 8, 12 ) / halfSin;
		b3.b3Body_SetAngularVelocity( drag.rec.body, { x: _q.x * f, y: _q.y * f, z: _q.z * f } );

	} else {

		b3.b3Body_SetAngularVelocity( drag.rec.body, { x: 0, y: 0, z: 0 } );

	}

}

function hop( rec ) {

	for ( const r of connectedOf( rec, true ) ) r.justPlaced = 0;
	unfreezeCluster( rec );
	const m = b3.b3Body_GetMass( rec.body );
	b3.b3Body_ApplyLinearImpulseToCenter( rec.body, {
		x: ( Math.random() - 0.5 ) * 2 * m,
		y: 5.5 * m,
		z: ( Math.random() - 0.5 ) * 2 * m,
	}, true );
	boing();

}

// ---------- 渲染同步 ----------

function markDirty() {

	lastDirty = performance.now();
	sceneDirty = true;

}

function addFieldBall( x, y, z, strength, color ) {

	const nx = x / ( 2 * FIELD_S ) + 0.5;
	const ny = Math.min( Math.max( ( y - FIELD_Y0 ) / ( 2 * FIELD_S ), 0.03 ), 0.95 );
	const nz = z / ( 2 * FIELD_S ) + 0.5;
	effect.addBall( nx, ny, nz, strength, SUBTRACT, color );

}

let buildFlip = false;

function rebuildClay() {

	// 全部睡着且没在拖拽时跳过重建（marching cubes 是 CPU 大头）
	let need = ! builtOnce || drag !== null || performance.now() - lastDirty < 1200;
	if ( ! need ) {

		for ( const r of balls ) {

			if ( b3.b3Body_IsAwake( r.body ) ) { need = true; break; }

		}

	}
	if ( ! need ) return;

	// 球很多时隔帧重建，视觉无感但省一半 CPU
	if ( builtOnce && balls.length > 20 ) {

		buildFlip = ! buildFlip;
		if ( buildFlip ) return;

	}

	effect.reset();
	const nowMs = performance.now();
	for ( const rec of balls ) {

		if ( rec.kind !== 'clay' ) continue;
		const p = b3.b3Body_GetPosition( rec.body );

		// 落地/撞击 → 挤压（竖直速度骤减触发），随后指数回弹
		const vel = b3.b3Body_GetLinearVelocity( rec.body );
		if ( rec.prevVy < - 2.5 && vel.y > rec.prevVy + 2 ) rec.squash = Math.min( 1, - rec.prevVy / 9 );
		rec.prevVy = vel.y;
		if ( rec.squash > 0.02 ) { rec.squash *= 0.88; markDirty(); } else rec.squash = 0;
		const squashDrop = rec.r * 0.38 * rec.squash;
		const squashBoost = 1 + 0.5 * rec.squash;

		// 出生弹跳：强度从 0 长到 1（带一点过冲）
		const age = ( nowMs - rec.bornAt ) / 240;
		const grow = age >= 1 ? 1 : easeOutBack( Math.max( 0.03, age ) );
		const gain = squashBoost * grow;

		const form = FORMS[ rec.form ];
		const rotated = form.sub.length > 1 || rec.dents.length > 0;

		if ( rotated ) {

			const q = b3.b3Body_GetRotation( rec.body );
			_q.set( q.v.x, q.v.y, q.v.z, q.s );

		}

		const k = rec.k;

		if ( form.sub.length === 1 ) {

			addFieldBall( p.x, p.y - squashDrop, p.z, strengthFor( form.sub[ 0 ].r * k ) * gain, rec.color );

		} else {

			// 子球局部偏移跟随刚体旋转，尺寸按件缩放
			for ( const sub of form.sub ) {

				_v.set( sub.o[ 0 ] * k, sub.o[ 1 ] * k, sub.o[ 2 ] * k ).applyQuaternion( _q );
				addFieldBall( p.x + _v.x, p.y + _v.y - squashDrop, p.z + _v.z, strengthFor( sub.r * k ) * gain, rec.color );

			}

		}

		// 坑（负，雕刻）/ 包（正）/ 彩点（正，自带颜色）——局部坐标已按 k 存储
		const dentS = strengthFor( DENT_R * k );
		const bumpS = strengthFor( DENT_R * 0.85 * k );
		for ( const d of rec.dents ) {

			_v.set( d[ 0 ], d[ 1 ], d[ 2 ] ).applyQuaternion( _q );
			if ( d[ 3 ] === 2 ) addFieldBall( p.x + _v.x, p.y + _v.y, p.z + _v.z, strengthFor( DAB_R[ d[ 5 ] === undefined ? 1 : d[ 5 ] ] * k ), DAB_COLORS[ d[ 4 ] || 0 ] );
			else addFieldBall( p.x + _v.x, p.y + _v.y, p.z + _v.z, d[ 3 ] === 1 ? bumpS : - dentS, rec.color );

		}

	}
	effect.update();
	builtOnce = true;

}

function syncEyes() {

	const nowMs = performance.now();
	for ( const rec of balls ) {

		if ( ! rec.mesh ) continue;
		const p = b3.b3Body_GetPosition( rec.body );
		const q = b3.b3Body_GetRotation( rec.body );
		rec.mesh.position.set( p.x, p.y, p.z );
		rec.mesh.quaternion.set( q.v.x, q.v.y, q.v.z, q.s );

		// 出生弹入 + 贴合时弹一下
		const age = ( nowMs - rec.bornAt ) / 240;
		let s = age >= 1 ? 1 : easeOutBack( Math.max( 0.03, age ) );
		if ( rec.popAt && nowMs - rec.popAt < 260 ) s *= 1 + 0.3 * Math.sin( ( nowMs - rec.popAt ) / 260 * Math.PI );
		rec.mesh.scale.setScalar( s );

		if ( rec.kind === 'eye' ) {

			const white = rec.mesh.children[ 0 ], pupil = rec.mesh.children[ 1 ];

			// 随机眨眼
			if ( nowMs >= rec.nextBlink ) {

				rec.blinkUntil = nowMs + 130;
				rec.nextBlink = nowMs + 1800 + Math.random() * 3500;

			}
			const blinking = nowMs < rec.blinkUntil;
			white.scale.y = blinking ? 0.18 : 1;
			pupil.visible = ! blinking;

			// 瞳孔追视：看手里拖着的东西，没有就看镜头
			rec.mesh.updateMatrixWorld();
			_v2.copy( drag && drag.rec !== rec ? drag.target : camera.position );
			rec.mesh.worldToLocal( _v2 );
			if ( _v2.z < 0.3 ) _v2.z = 0.3;
			_v2.normalize();
			pupil.position.set( _v2.x * EYE_R * 0.5, _v2.y * EYE_R * 0.5, Math.max( 0.5, _v2.z ) * EYE_R * 0.72 );

		}

	}

}

// ---------- 输入 ----------

function setRay( e ) {

	pointerNdc.set( ( e.clientX / innerWidth ) * 2 - 1, - ( e.clientY / innerHeight ) * 2 + 1 );
	raycaster.setFromCamera( pointerNdc, camera );

}

function rayPlaneY( y, out ) {

	_plane.set( UP, - y );
	return raycaster.ray.intersectPlane( _plane, out );

}

function clampPlay( v, margin ) {

	const r = Math.hypot( v.x, v.z );
	const maxR = BOARD_HALF - margin;
	if ( r > maxR ) { const s = maxR / r; v.x *= s; v.z *= s; }
	return v;

}

function pickBall() {

	let best = null, bestT = Infinity;
	const hit = new THREE.Vector3();
	for ( const rec of balls ) {

		const p = b3.b3Body_GetPosition( rec.body );
		_sphere.center.set( p.x, p.y, p.z );
		_sphere.radius = pickRadiusOf( rec ) * ( COARSE ? 1.4 : 1.05 );
		if ( raycaster.ray.intersectSphere( _sphere, hit ) ) {

			// 眼睛小且常被大黏土的拾取球挡住，给一点优先级
			const t = hit.distanceTo( raycaster.ray.origin ) - ( rec.kind === 'eye' ? 0.3 : 0 );
			if ( t < bestT ) { bestT = t; best = rec; }

		}

	}
	return best;

}

function startDrag( rec ) {

	// 拿在手里的东西不归物理管：转运动学体，1:1 跟手、不被路上的东西挂住。
	// 起点就是当前位置：短按不预抬，免得单击时球被“拽”一下
	const p = b3.b3Body_GetPosition( rec.body );
	const q = b3.b3Body_GetRotation( rec.body );
	drag = {
		rec,
		target: new THREE.Vector3( p.x, p.y, p.z ),
		targetQuat: new THREE.Quaternion( q.v.x, q.v.y, q.v.z, q.s ),
	};
	rec.frozen = false;
	rec.slowTicks = 0;
	b3.b3Body_SetType( rec.body, b3.b3BodyType.b3_kinematicBody );
	b3.b3Body_SetAwake( rec.body, true );

}

// 松手：还给物理世界（速度由 SetTargetTransform 遗留，甩出去仍有惯性）
function endDrag() {

	hideSnapRing();
	if ( drag && drag.rec.alive ) {

		b3.b3Body_SetType( drag.rec.body, b3.b3BodyType.b3_dynamicBody );
		b3.b3Body_SetAwake( drag.rec.body, true );
		// 整个连通团都拿到“刚放置”资格：任一成员先稳住就把整团锚定（头重脚轻的组件才装得上去）
		for ( const r of connectedOf( drag.rec, true ) ) r.justPlaced = stepCount;

	}
	drag = null;

}

// 第二指移动：距离变化 = 缩放，角度变化 = 绕 Y 旋转
function updatePinch( e ) {

	const P = session.pinch, rec = session.rec;
	if ( ! rec.alive ) return;

	const p1 = session.p1 || { x: session.x0, y: session.y0 };
	const dx = e.clientX - p1.x, dy = e.clientY - p1.y;
	const dist = Math.max( 1, Math.hypot( dx, dy ) );
	const angle = Math.atan2( dy, dx );

	// 缩放：按 7% 步进重建物理形状，避免每帧换 shape。首次生效前先拆焊（否则焊点错位）
	const targetK = THREE.MathUtils.clamp( P.startK * dist / P.startDist, 0.5, 1.9 );
	if ( Math.abs( targetK / P.appliedK - 1 ) > 0.07 ) {

		if ( ! P.detached ) { detach( rec, true ); P.detached = true; }
		applyScale( rec, targetK );
		P.appliedK = targetK;
		squish();

	}

	// 两指靠得太近时角度对像素抖动极敏感，冻结旋转
	if ( dist < 40 ) { P.lastAngle = angle; return; }

	// 旋转：屏幕上的顺时针 ≈ 从上往下看的顺时针 = 负 yaw
	let dA = angle - P.lastAngle;
	if ( dA > Math.PI ) dA -= Math.PI * 2;
	if ( dA < - Math.PI ) dA += Math.PI * 2;
	P.lastAngle = angle;
	if ( Math.abs( dA ) > 0.002 && drag ) {

		if ( ! P.detached ) { detach( rec, true ); P.detached = true; }
		drag.targetQuat.premultiply( new THREE.Quaternion().setFromAxisAngle( UP, - dA ) );
		markDirty();

	}

}

function onPointerMove( e ) {

	if ( ! session ) return;

	if ( session.pinch && e.pointerId === session.pinch.id2 ) { updatePinch( e ); return; }
	if ( e.pointerId !== session.pointerId ) return;

	session.p1 = { x: e.clientX, y: e.clientY };

	if ( Math.hypot( e.clientX - session.x0, e.clientY - session.y0 ) > ( session.type === 'palette' ? 10 : 6 ) ) {

		session.moved = true;

	}

	setRay( e );

	// 捏 / 上色：沿划动路径隔一小段落一个点
	if ( session.type === 'knead' || session.type === 'paint' ) {

		// 拖出很远说明是想搬家，提示先退出工具模式
		if ( ! session.warned && Math.hypot( e.clientX - session.x0, e.clientY - session.y0 ) > 90 ) {

			session.warned = true;
			setHint( '想搬家？先点工具按钮收手，再拖就能移动啦' );

		}

		const step = session.type === 'paint' ? 0.15 : DENT_STEP;
		if ( session.rec.alive && kneadHit( session.rec, _v ) ) {

			if ( ! session.lastDent || _v.distanceTo( session.lastDent ) > step ) {

				if ( session.type === 'knead' ) addDentAt( session.rec, _v );
				else addDabAt( session.rec, _v, selected, sizeIndex );
				session.dentCount = ( session.dentCount || 1 ) + 1;
				session.lastDent = _v.clone();

			}
			session.pulled = false; // 回到表面上，允许下一次外拉

		} else if ( session.type === 'knead' && session.rec.alive && session.lastDent && ! session.pulled && ( session.dentCount || 1 ) <= 2 ) {

			// 短按后立刻划出表面 = 往外拉：鼓一个包。刻了一路沟再出界的不算（那是划过头）
			addBumpAt( session.rec, session.lastDent );
			session.pulled = true;

		}
		return;

	}

	// 从调色盘拖出来：第一次移动时才真正生成
	if ( session.type === 'palette' && session.moved && session.pending ) {

		if ( rayPlaneY( LIFT_Y, _v ) ) {

			clampPlay( _v, 0.4 );
			session.pending = false;
			if ( session.kind === 'chain' ) {

				createChain( _v.x, _v.z, selected );
				return;

			}
			const rec = session.kind === 'clay'
				? createClay( _v.x, LIFT_Y, _v.z, session.colorIndex )
				: createDecor( session.kind, _v.x, LIFT_Y, _v.z );
			if ( rec ) {

				session.type = 'ball';
				session.rec = rec;
				session.isNewDecor = session.kind !== 'clay'; // ↺ 时新贴件直接收回
				startDrag( rec );
				drag.target.set( _v.x, LIFT_Y, _v.z );

			}

		}
		return;

	}

	if ( drag && session.rec ) {

		// 贴件优先沿黏土表面滑动：贴在哪儿看得见、朝外站好（精确放置）；手办等大件不吸表面
		if ( drag.rec.kind !== 'clay' && DECOR[ drag.rec.kind ] ) {

			const hit = surfaceHit();
			if ( hit ) {

				const out = DECOR[ drag.rec.kind ].out;
				drag.surface = hit.host;
				drag.target.set(
					hit.pos.x + hit.normal.x * out,
					hit.pos.y + hit.normal.y * out,
					hit.pos.z + hit.normal.z * out );
				drag.targetQuat.setFromUnitVectors( Z_OUT, hit.normal );
				showSnapRing( hit );
				return;

			}
			drag.surface = null;
			hideSnapRing();

		}

		if ( rayPlaneY( drag.target.y, _v ) ) {

			clampPlay( _v, 0.35 );
			drag.target.set( _v.x, drag.target.y, _v.z );

		}

	}

}

function onPointerUp( e ) {

	if ( ! session ) return;
	// 第二根手指抬起：结束捏合（清冷却让它立刻能黏回邻居），主手指继续拖
	if ( session.pinch && e.pointerId === session.pinch.id2 ) {

		session.pinch = null;
		if ( session.rec && session.rec.alive ) clearCooldownsFor( session.rec.id );
		return;

	}
	if ( e.pointerId !== session.pointerId ) return;
	const dt = performance.now() - session.t0;

	if ( session.type === 'ball' && session.rec ) {

		if ( ! session.moved && ! session.hadPinch && dt < 300 && session.rec.alive ) {

			// 点一下跳一跳（延迟到双击窗口之后），双击拆开
			if ( lastTap.rec === session.rec && performance.now() - lastTap.t < 350 ) {

				if ( pendingHop && pendingHop.rec === session.rec ) {

					clearTimeout( pendingHop.timer );
					pendingHop = null;

				}
				detach( session.rec );
				lastTap = { rec: null, t: 0 };

			} else {

				const rec = session.rec;
				if ( pendingHop ) clearTimeout( pendingHop.timer );
				pendingHop = { rec, timer: setTimeout( () => {

					if ( rec.alive ) hop( rec );
					pendingHop = null;

				}, 280 ) };
				lastTap = { rec, t: performance.now() };

			}

		}

		// 拖着贴件在黏土表面上松手：进入待确认（✓ 贴好 / ↺ 放回），而不是掉下去
		if ( drag && drag.rec.kind !== 'clay' && drag.surface && session.moved && drag.rec.alive ) {

			enterTentative( drag.rec, session, drag.surface );
			drag = null;

		} else {

			endDrag();

		}

	} else if ( session.type === 'table' ) {

		// 双击窗口内不在桌面生成新球——那多半是第二击落空了
		if ( ! session.moved && dt < 400 && session.spawn && performance.now() - lastTap.t > 350 ) {

			createClay( session.spawn.x, 2.8 + Math.random() * 0.6, session.spawn.z, selected, { x: 0, y: - 2, z: 0 } );

		}

	} else if ( session.type === 'palette' && session.pending && ! session.moved ) {

		// 点一下调色盘：随机丢一颗进来
		const rx = ( Math.random() - 0.5 ) * 1.6, rz = ( Math.random() - 0.5 ) * 1.6;
		if ( session.kind === 'clay' ) createClay( rx, 3.4, rz, session.colorIndex );
		else if ( session.kind === 'chain' ) createChain( rx, rz, selected );
		else createDecor( session.kind, rx, 3.4, rz );

	}

	endSession();

}

function onPointerCancel( e ) {

	if ( ! session ) return;
	if ( session.pinch && e.pointerId === session.pinch.id2 ) {

		session.pinch = null;
		if ( session.rec && session.rec.alive ) clearCooldownsFor( session.rec.id );
		return;

	}
	if ( e.pointerId !== session.pointerId ) return;
	endDrag();
	endSession();

}

// rec 是否属于软链（链节不参与捏合缩放，否则关节锚点会错位）
function isChainSeg( rec ) {

	return joints.some( ( j ) => j.chain && ( j.aId === rec.id || j.bId === rec.id ) );

}

// 清掉某件的重贴冷却：捏合结束后若还贴着邻居，立即黏回去，别让作品无声解体
function clearCooldownsFor( id ) {

	for ( const key of [ ...noStickUntil.keys() ] ) {

		const parts = key.split( '|' );
		if ( + parts[ 0 ] === id || + parts[ 1 ] === id ) noStickUntil.delete( key );

	}

}

// 按住不动的黏土每隔一段时间变一次形：圆球 → 压扁 → 搓长 → 圆球…
function armMorphHold( s ) {

	s.holdTimer = setTimeout( function tick() {

		if ( session !== s || s.moved || ! s.rec.alive ) return;
		setForm( s.rec, ( s.rec.form + 1 ) % FORMS.length );
		s.morphed = true;
		s.holdTimer = setTimeout( tick, MORPH_HOLD_MS );

	}, MORPH_HOLD_MS );

}

function endSession() {

	if ( session && session.holdTimer ) clearTimeout( session.holdTimer );
	if ( session && session.rec && session.rec.alive
		&& ( session.hadPinch || session.rec.kind !== 'clay' ) ) {

		// 捏合过的黏土 / 拖完的贴件：清掉重贴冷却，落点处立即粘住
		clearCooldownsFor( session.rec.id );

	}
	session = null;
	window.removeEventListener( 'pointermove', onPointerMove );
	window.removeEventListener( 'pointerup', onPointerUp );
	window.removeEventListener( 'pointercancel', onPointerCancel );

}

function cancelSession() {

	endDrag();
	endSession();

}

// pointerup 可能被系统手势/来电吞掉，残留的会话会挡住之后所有触摸。
// 新触摸 isPrimary=true 意味着旧手指必然已离屏（真正的多指时第二指是 false），可以安全回收。
function reclaimStalePointer( e ) {

	if ( session && e.isPrimary ) cancelSession();

}

function beginSession( s ) {

	session = s;
	window.addEventListener( 'pointermove', onPointerMove );
	window.addEventListener( 'pointerup', onPointerUp );
	window.addEventListener( 'pointercancel', onPointerCancel );

}

function setupPointer() {

	const canvas = renderer.domElement;

	canvas.addEventListener( 'contextmenu', ( e ) => e.preventDefault() );

	// 待确认的贴件不挡任何操作：碰别处就当“就这样吧”，立即贴好
	window.addEventListener( 'pointerdown', ( e ) => {

		if ( tentative && ! ( e.target && e.target.closest && e.target.closest( '#confirmBar' ) ) ) commitTentative();

	}, true );

	// 切后台 / 失焦时正在进行的会话一并取消，防止残留；顺手把作品立即存档
	window.addEventListener( 'blur', () => { cancelSession(); wsCancelPlace(); } );
	document.addEventListener( 'visibilitychange', () => {

		if ( document.hidden ) {

			commitTentative();
			cancelSession();
			saveScene();

		}

	} );

	canvas.addEventListener( 'pointerdown', ( e ) => {

		// 工坊模式：画布输入全部交给工坊（转转盘；Stage 3 起还有部件放置）
		if ( workshop ) { wsPointerDown( e ); return; }

		reclaimStalePointer( e );
		if ( session ) {

			// 第二根手指落在画布上：正拖着一块黏土时进入捏合（缩放 + 旋转）
			if ( session.type === 'ball' && session.rec.alive
				&& session.rec.kind === 'clay' && ! isChainSeg( session.rec )
				&& e.pointerId !== session.pointerId ) {

				const p1 = session.p1 || { x: session.x0, y: session.y0 };
				const dx = e.clientX - p1.x, dy = e.clientY - p1.y;
				const dist = Math.hypot( dx, dy );

				if ( session.pinch ) {

					if ( e.pointerId === session.pinch.id2 ) {

						// 同 id 再次落下：up 被系统吞了的残留指针，原地重锚（否则跳变）
						session.pinch.startDist = Math.max( 1, dist );
						session.pinch.lastAngle = Math.atan2( dy, dx );
						session.pinch.startK = session.rec.k;
						session.pinch.appliedK = session.rec.k;

					} else {

						// 第三个触点：多半是手掌压上来，撤销捏合、恢复按住变形
						session.pinch = null;
						clearCooldownsFor( session.rec.id );
						if ( ! session.moved && ! session.holdTimer ) armMorphHold( session );

					}
					return;

				}

				// 离主指太近的触点多为手掌边缘/并拢的手指：忽略，别打断按住变形
				if ( dist < 60 ) return;

				session.pinch = {
					id2: e.pointerId,
					startDist: dist,
					lastAngle: Math.atan2( dy, dx ),
					startK: session.rec.k,
					appliedK: session.rec.k,
					detached: false,
				};
				session.hadPinch = true;
				if ( session.holdTimer ) { clearTimeout( session.holdTimer ); session.holdTimer = null; }

			}
			return;

		}
		ensureAudio();
		stopDemo();
		setRay( e );

		const rec = pickBall();

		// 工具模式：🤏 捏 / ✂️ 剪 / 🖌 上色（按在黏土上不再是拖拽）
		if ( mode && rec && rec.kind === 'clay' ) {

			if ( mode === 'cut' ) { cutPiece( rec ); return; }

			beginSession( { type: mode, rec, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: false, lastDent: null, dentCount: 1 } );
			if ( kneadHit( rec, _v ) ) {

				if ( mode === 'knead' ) addDentAt( rec, _v );
				else addDabAt( rec, _v, selected, sizeIndex );
				session.lastDent = _v.clone();

			}
			return;

		}

		if ( rec ) {

			beginSession( { type: 'ball', rec, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: false } );
			if ( rec.kind === 'clay' ) { unfreezeCluster( rec ); armMorphHold( session ); }
			else {

				// 抓贴件 = 单独挪贴件（解冻并安静地从作品上拆下来）；抓黏土才是搬整团。
				// 先记住原位和原宿主：精确放置后 ↺ 能放回去
				const p0 = b3.b3Body_GetPosition( rec.body );
				const q0 = b3.b3Body_GetRotation( rec.body );
				session.restore = {
					p: { x: p0.x, y: p0.y, z: p0.z },
					q: { v: { x: q0.v.x, y: q0.v.y, z: q0.v.z }, s: q0.s },
					hosts: joints.filter( ( j ) => j.aId === rec.id || j.bId === rec.id )
						.map( ( j ) => balls.find( ( r ) => r.id === ( j.aId === rec.id ? j.bId : j.aId ) ) )
						.filter( ( r ) => r && r.alive ),
				};
				unfreeze( rec );
				detach( rec, true );

			}
			startDrag( rec );

		} else {

			let spawn = null;
			if ( rayPlaneY( 0, _v ) && Math.hypot( _v.x, _v.z ) < BOARD_HALF - 0.3 ) spawn = _v.clone();
			beginSession( { type: 'table', pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: false, spawn } );

		}

	} );

}

// ---------- UI ----------

function shakePalette() {

	const el = document.getElementById( 'palette' );
	el.classList.remove( 'shake' );
	void el.offsetWidth;
	el.classList.add( 'shake' );

}

function selectColor( i ) {

	selected = i;
	document.querySelectorAll( '#palette .color' ).forEach( ( el, j ) => {

		el.classList.toggle( 'selected', j === i );

	} );

}

function setupUI() {

	const colorRow = document.getElementById( 'colorRow' );

	CLAY_COLORS.forEach( ( c, i ) => {

		const btn = document.createElement( 'button' );
		btn.className = 'color';
		btn.style.background = '#' + c.toString( 16 ).padStart( 6, '0' );
		// 手捏的黏土团：每颗形状和歪度都略不同
		const blobs = [
			'46% 54% 52% 48% / 52% 44% 56% 48%',
			'53% 47% 44% 56% / 46% 55% 45% 54%',
			'48% 52% 55% 45% / 55% 48% 52% 45%',
			'55% 45% 48% 52% / 47% 53% 47% 53%',
			'44% 56% 50% 50% / 53% 45% 55% 47%',
			'51% 49% 56% 44% / 44% 54% 46% 56%',
		];
		btn.style.borderRadius = blobs[ i % blobs.length ];
		btn.style.setProperty( '--rot', [ - 4, 3, - 2, 4, - 3, 2, 3, - 3, 2, - 4, 4, - 2 ][ i % 12 ] + 'deg' );
		btn.addEventListener( 'pointerdown', ( e ) => {

			reclaimStalePointer( e );
			if ( session ) return;
			e.preventDefault();
			ensureAudio();
			stopDemo();
			selectColor( i );
			if ( mode === 'paint' ) return; // 上色模式：点色块只是换颜料
			beginSession( { type: 'palette', kind: 'clay', colorIndex: i, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: false, pending: true } );

		} );
		colorRow.appendChild( btn );

	} );

	selectColor( 0 );

	// 🧸 手办工坊：入口、返回、换身体、转一转、工坊色板
	document.getElementById( 'wsBtn' ).addEventListener( 'pointerdown', ( e ) => {

		reclaimStalePointer( e );
		if ( session ) return;
		e.preventDefault();
		ensureAudio();
		stopDemo();
		enterWorkshop();

	} );
	document.getElementById( 'wsBackBtn' ).addEventListener( 'pointerdown', ( e ) => {

		e.preventDefault();
		ensureAudio();
		exitWorkshop();

	} );
	document.getElementById( 'wsBodyBtn' ).addEventListener( 'pointerdown', ( e ) => {

		e.preventDefault();
		if ( ! workshop ) return;
		ensureAudio();
		workshop.tplIndex = ( workshop.tplIndex + 1 ) % BODY_TEMPLATES.length;
		rebuildWsBody();

	} );
	document.getElementById( 'wsTurnBtn' ).addEventListener( 'pointerdown', ( e ) => {

		e.preventDefault();
		if ( ! workshop ) return;
		ensureAudio();
		workshop.yawVel += 5;
		boing();

	} );
	// ✓ 完成：手办变成黏土板上的一件玩具（单刚体），工坊清空迎接下一只
	document.getElementById( 'wsDoneBtn' ).addEventListener( 'pointerdown', ( e ) => {

		e.preventDefault();
		if ( ! workshop || ! workshop.figureMesh || wsPlace ) return;
		ensureAudio();
		const fd = wsFigData( workshop );

		// 拆台清场：部件与身体从转盘摘掉
		for ( const en of [ ...workshop.parts ] ) wsDiscardEntry( en );
		wsStage.figure.remove( workshop.figureMesh );
		workshop.figureMesh.geometry.dispose();
		workshop.figureMesh = null;
		exitWorkshop();
		wsKeep = null; // 下次进来是新的一只

		createFigure( fd, ( Math.random() - 0.5 ) * 0.8, 0.4, ( Math.random() - 0.5 ) * 0.8 );
		userTouched = true;
		saveScene();
		setHint( '🧸 它来啦！拖着玩、点一点跳、🎥 拍段短片吧' );
		setTimeout( () => { if ( ! workshop ) resetHint(); }, 4000 );

	} );
	// 部件货架：点一下上膛（下一按放置），直接拖出来立即开始放
	document.querySelectorAll( '#wsPartRow button' ).forEach( ( btn ) => {

		btn.addEventListener( 'pointerdown', ( e ) => {

			e.preventDefault();
			if ( ! workshop || wsPlace || wsShelf ) return;
			ensureAudio();
			const partId = btn.dataset.part;
			workshop.placing = workshop.placing === partId ? null : partId; // 再点一次取消上膛
			selectWsShelf( workshop.placing );
			if ( workshop.placing ) {

				wsShelf = { id: e.pointerId, partId, x0: e.clientX, y0: e.clientY };
				window.addEventListener( 'pointermove', wsShelfMove );
				window.addEventListener( 'pointerup', wsShelfUp );
				setHint( '🧸 按到小家伙身上拖一拖，松手就长上啦（成对的会自动长两个）' );

			}

		} );

	} );

	const wsColorRow = document.getElementById( 'wsColorRow' );
	CLAY_COLORS.forEach( ( c, i ) => {

		const btn = document.createElement( 'button' );
		btn.className = 'color';
		btn.style.background = '#' + c.toString( 16 ).padStart( 6, '0' );
		btn.style.borderRadius = [ '46% 54% 52% 48% / 52% 44% 56% 48%', '53% 47% 44% 56% / 46% 55% 45% 54%', '48% 52% 55% 45% / 55% 48% 52% 45%' ][ i % 3 ];
		btn.style.setProperty( '--rot', [ - 3, 2, - 2, 3 ][ i % 4 ] + 'deg' );
		btn.addEventListener( 'pointerdown', ( e ) => {

			e.preventDefault();
			if ( ! workshop ) return;
			ensureAudio();

			// 上膛/正在放的是色片这类"自带颜色"的部件：点色块只是换颜料，不动身体
			const placingOwn = ( workshop.placing && PARTS[ workshop.placing ].role === 'own' )
				|| ( wsPlace && wsPlace.entry.role === 'own' );
			if ( placingOwn ) {

				workshop.partColorIndex = i;
				if ( wsPlace && wsPlace.entry.role === 'own' ) {

					wsPlace.entry.colorHex = CLAY_COLORS[ i ];
					for ( const m of wsPlace.entry.mats ) m.color.setHex( CLAY_COLORS[ i ] );

				}
				selectWsColor( i );
				dabTick();
				return;

			}

			workshop.colorIndex = i;
			if ( workshop.bodyMat ) workshop.bodyMat.color.setHex( CLAY_COLORS[ i ] );
			// 跟身体同色的部件（耳朵、小手）一起换：玩偶服是一体的
			for ( const en of workshop.parts ) {

				if ( en.role === 'body' ) for ( const m of en.mats ) m.color.setHex( CLAY_COLORS[ i ] );

			}
			selectWsColor( i );
			dabTick();

		} );
		wsColorRow.appendChild( btn );

	} );

	// 贴件放置确认气泡：✓ 贴好 / ↺ 放回
	confirmBarEl = document.getElementById( 'confirmBar' );
	document.getElementById( 'confirmYes' ).addEventListener( 'pointerdown', ( e ) => {

		e.preventDefault();
		ensureAudio();
		commitTentative();

	} );
	document.getElementById( 'confirmNo' ).addEventListener( 'pointerdown', ( e ) => {

		e.preventDefault();
		ensureAudio();
		cancelTentative();

	} );

	// ● 大小切换：影响之后新加的黏土（和小蛇）
	const sizeBtn = document.getElementById( 'sizeBtn' );
	const sizeSvg = sizeBtn.querySelector( 'svg' );
	const applySizeBtn = () => { sizeSvg.style.transform = [ 'scale(0.6)', 'scale(0.85)', 'scale(1.12)' ][ sizeIndex ]; };
	applySizeBtn();
	sizeBtn.addEventListener( 'pointerdown', ( e ) => {

		reclaimStalePointer( e );
		if ( session ) return;
		e.preventDefault();
		ensureAudio();
		sizeIndex = ( sizeIndex + 1 ) % SIZES.length;
		applySizeBtn();
		boing();

	} );

	for ( const [ id, kind ] of [ [ 'chainBtn', 'chain' ], [ 'eyeBtn', 'eye' ], [ 'mouthBtn', 'mouth' ], [ 'hatBtn', 'hat' ], [ 'bowBtn', 'bow' ] ] ) {

		document.getElementById( id ).addEventListener( 'pointerdown', ( e ) => {

			reclaimStalePointer( e );
			if ( session ) return;
			e.preventDefault();
			ensureAudio();
			stopDemo();
			beginSession( { type: 'palette', kind, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: false, pending: true } );

		} );

	}

	// 🤸 翻跟头：拖住一块黏土时点一下，绕水平轴翻 90°（松手后定型就能立住）
	document.getElementById( 'flipBtn' ).addEventListener( 'pointerdown', ( e ) => {

		e.preventDefault();
		ensureAudio();
		if ( drag && drag.rec.alive ) {

			// 翻转轴取水平面内垂直于该件长轴（local X）的方向：躺着的翻起来站直，站着的翻回躺平
			const lx = new THREE.Vector3( 1, 0, 0 ).applyQuaternion( drag.targetQuat );
			lx.y = 0;
			let axis;
			if ( lx.lengthSq() < 0.1 ) axis = new THREE.Vector3( 1, 0, 0 );
			else { lx.normalize(); axis = new THREE.Vector3( - lx.z, 0, lx.x ); }
			drag.targetQuat.premultiply( new THREE.Quaternion().setFromAxisAngle( axis, - Math.PI / 2 ) );
			markDirty();
			boing();

		} else {

			setHint( '🤸 先按住一块黏土不放，另一只手点我翻跟头' );
			setTimeout( () => { if ( ! demoRun ) resetHint(); }, 2600 );

		}

	} );

	// 工具模式：🤏 捏 / ✂️ 剪 / 🖌 上色（互斥，再点收手）
	hintEl = document.getElementById( 'hint' );
	defaultHint = hintEl.textContent;
	const modeBtns = {
		knead: document.getElementById( 'kneadBtn' ),
		cut: document.getElementById( 'cutBtn' ),
		paint: document.getElementById( 'paintBtn' ),
	};
	const setMode = ( m ) => {

		mode = mode === m ? null : m;
		for ( const [ k, b ] of Object.entries( modeBtns ) ) b.classList.toggle( 'selected', mode === k );
		resetHint();

	};
	for ( const [ m, btn ] of Object.entries( modeBtns ) ) {

		btn.addEventListener( 'pointerdown', ( e ) => {

			reclaimStalePointer( e );
			if ( session ) return;
			e.preventDefault();
			ensureAudio();
			stopDemo();
			setMode( m );

		} );

	}

	// 🎬 看表演：游戏自己捏一个造型给你看
	const demoBtn = document.getElementById( 'demoBtn' );
	demoBtn.addEventListener( 'pointerdown', ( e ) => {

		reclaimStalePointer( e );
		if ( session ) return;
		e.preventDefault();
		ensureAudio();

		if ( demoRun ) { stopDemo(); return; }

		// 盘上有作品时需要二次确认（开演会收走作品）：武装 5 秒，期间按钮脉动提示“再点一下”
		if ( balls.length > 4 && performance.now() > demoArmedAt ) {

			demoArmedAt = performance.now() + 5000;
			demoBtn.classList.add( 'armed' );
			setHint( '再点一下 🎬 开始表演（会收走现在的作品哦）' );
			setTimeout( () => {

				demoBtn.classList.remove( 'armed' );
				if ( ! demoRun ) resetHint();

			}, 5000 );
			return;

		}

		demoBtn.classList.remove( 'armed' );
		demoArmedAt = 0;
		startDemo();

	} );

	// 🎥 作品短片
	document.getElementById( 'clipBtn' ).addEventListener( 'pointerdown', ( e ) => {

		reclaimStalePointer( e );
		if ( session ) return;
		e.preventDefault();
		ensureAudio();
		stopDemo();
		recordClip();

	} );

	// 清空是不可挽回的：按住 0.7 秒才触发，防止小孩误触
	const clearBtn = document.getElementById( 'clearBtn' );
	let clearHold = null;

	const cancelClearHold = () => {

		if ( clearHold === null ) return;
		clearTimeout( clearHold );
		clearHold = null;
		clearBtn.classList.remove( 'holding' );

	};

	clearBtn.addEventListener( 'pointerdown', ( e ) => {

		reclaimStalePointer( e );
		if ( session ) return;
		e.preventDefault();
		ensureAudio();
		stopDemo();
		clearBtn.classList.add( 'holding' );
		clearHold = setTimeout( () => {

			clearHold = null;
			clearBtn.classList.remove( 'holding' );
			clearAll();

		}, 700 );

	} );

	for ( const type of [ 'pointerup', 'pointerleave', 'pointercancel' ] ) {

		clearBtn.addEventListener( type, cancelClearHold );

	}

}

// ---------- 🎬 表演模式：游戏当面捏一遍食谱，带解说 ----------

// 表演的等待以物理步数为时钟：后台页签定时器会被浏览器钳流，
// 而步数时钟让表演跟着模拟一起暂停/恢复
const demoWaiters = [];

function pumpDemoWaiters() {

	for ( let i = demoWaiters.length - 1; i >= 0; i -- ) {

		const w = demoWaiters[ i ];
		if ( w.token !== demoRun ) {

			demoWaiters.splice( i, 1 );
			w.reject( new Error( 'demo-stopped' ) );

		} else if ( stepCount >= w.target ) {

			demoWaiters.splice( i, 1 );
			w.resolve();

		}

	}

}

function stopDemo() {

	if ( ! demoRun ) return;
	demoRun = null;
	pumpDemoWaiters();
	resetHint();

}

// 六个实测过的食谱。坐标都来自验证脚本，节奏按真人观看调慢
const DEMO_RECIPES = [
	{ name: '雪人', run: async ( S ) => {

		S.say( '先放一颗球' );
		S.clay( 0, 0.25, 4 ); await S.wait( 1100 );
		S.say( '再叠一颗，黏住啦' );
		S.clay( 0.02, 0.27, 4 ); await S.wait( 1400 );
		S.say( '戴顶帽子' );
		S.decor( 'hat', 0, 0.2 ); await S.wait( 1100 );
		S.say( '贴眼睛和嘴巴' );
		S.eye( - 0.15, 0.62 ); await S.wait( 800 );
		S.eye( 0.17, 0.64 ); await S.wait( 800 );
		S.decor( 'mouth', 0.01, 0.6 ); await S.wait( 1400 );

	} },
	{ name: '毛毛虫', run: async ( S ) => {

		S.say( '把小球排成一行，它们会自己黏住' );
		for ( let i = 0; i < 4; i ++ ) { S.clay( - 1.6 + i * 1.05, 0.3, 3 ); await S.wait( 1200 ); }
		S.say( '头上贴两只眼睛' );
		S.eye( - 1.78, 0.42 ); await S.wait( 900 );
		S.eye( - 1.42, 0.44 ); await S.wait( 1400 );

	} },
	{ name: '小花', run: async ( S ) => {

		S.say( '中间放一颗花心' );
		S.clay( 0, 0, 2 ); await S.wait( 1100 );
		S.say( '周围摆一圈小球' );
		const petals = [];
		for ( let i = 0; i < 6; i ++ ) {

			const a = i / 6 * Math.PI * 2;
			petals.push( S.clay( Math.cos( a ) * 1.22, Math.sin( a ) * 1.22, 0 ) );
			await S.wait( 1000 );

		}
		S.say( '挨个按住，压扁成花瓣！' );
		for ( const p of petals ) { S.morph( p ); await S.wait( 900 ); }
		await S.wait( 1200 );

	} },
	{ name: '蜗牛', run: async ( S ) => {

		S.say( '放一颗球' );
		const b = S.clay( 0.3, 0.4, 5 ); await S.wait( 1100 );
		S.say( '按住两下：搓成香肠身体' );
		S.morph( b ); await S.wait( 900 );
		S.morph( b ); await S.wait( 1300 );
		S.say( '背上放一颗球当壳' );
		const p = S.pos( b );
		if ( p ) S.clay( p.x, p.z, 0 );
		await S.wait( 1600 );

	} },
	{ name: '章鱼', run: async ( S ) => {

		S.say( '叠两颗球做身体' );
		S.clay( 0, - 0.1, 5 ); await S.wait( 1100 );
		S.clay( 0.02, - 0.08, 5 ); await S.wait( 1400 );
		S.say( '周围摆四颗球' );
		const legs = [];
		for ( const deg of [ 25, 115, 205, 295 ] ) {

			const a = deg * Math.PI / 180;
			legs.push( S.clay( Math.cos( a ) * 1.2, - 0.1 + Math.sin( a ) * 1.2, 5 ) );
			await S.wait( 1000 );

		}
		S.say( '挨个搓长，就是触手！' );
		for ( const t of legs ) { S.morph( t ); await S.wait( 600 ); S.morph( t ); await S.wait( 800 ); }
		S.say( '贴上眼睛' );
		S.eye( - 0.2, 0.32 ); await S.wait( 800 );
		S.eye( 0.24, 0.34 ); await S.wait( 1400 );

	} },
	{ name: '甜甜圈', run: async ( S ) => {

		S.say( '一颗球，按住变扁' );
		const d = S.clay( 0, 0.3, 2 ); await S.wait( 1100 );
		S.morph( d ); await S.wait( 1300 );
		S.say( '🤏 往中间使劲戳！' );
		for ( let k = 0; k < 8; k ++ ) { S.poke( d, 0, 1, 0 ); await S.wait( 320 ); }
		await S.wait( 1300 );

	} },
	{ name: '小蛇', run: async ( S ) => {

		S.say( '🐍 放一条软软的小蛇' );
		const segs = S.chain( 0, 0.3, 3 );
		await S.wait( 1800 );
		if ( segs.length ) {

			S.say( '头上贴眼睛' );
			const p = S.pos( segs[ 0 ] );
			if ( p ) {

				S.eye( p.x - 0.18, p.z + 0.22 ); await S.wait( 800 );
				S.eye( p.x + 0.14, p.z + 0.24 );

			}

		}
		await S.wait( 1500 );

	} },
	{ name: '生日蛋糕', run: async ( S ) => {

		S.say( '烤一个大蛋糕底' );
		const base = S.clay( 0, 0, 2, 1.5 ); await S.wait( 1100 );
		S.morph( base ); await S.wait( 1300 );
		S.say( '再叠一层' );
		const mid = S.clay( 0.02, 0.02, 0, 1.05 ); await S.wait( 1300 );
		S.morph( mid ); await S.wait( 1300 );
		S.say( '顶上一颗小圆顶' );
		S.clay( 0, 0.03, 5, 0.62 ); await S.wait( 1400 );
		S.say( '🖌 挤一圈糖霜' );
		for ( let i = 0; i < 6; i ++ ) {

			const a = i / 6 * Math.PI * 2;
			S.dab( base, Math.cos( a ) * 0.6, 1, Math.sin( a ) * 0.6, 4 );
			await S.wait( 240 );

		}
		for ( let i = 0; i < 4; i ++ ) {

			const a = i / 4 * Math.PI * 2 + 0.4;
			S.dab( mid, Math.cos( a ) * 0.5, 1, Math.sin( a ) * 0.5, 2 );
			await S.wait( 240 );

		}
		S.say( '插上蜡烛！' );
		S.decor( 'hat', 0, - 0.02 );
		await S.wait( 1600 );

	} },
	{ name: '汉堡', run: async ( S ) => {

		S.say( '下层面包' );
		const bun = S.clay( 0, 0.1, 1, 1.25 ); await S.wait( 1100 );
		S.morph( bun ); await S.wait( 1200 );
		S.say( '生菜～' );
		const let2 = S.clay( 0.02, 0.12, 3, 1.15 ); await S.wait( 1200 );
		S.morph( let2 ); await S.wait( 1100 );
		S.say( '肉饼！' );
		const pat = S.clay( 0, 0.08, 0, 1.05 ); await S.wait( 1200 );
		S.morph( pat ); await S.wait( 1100 );
		S.say( '盖上圆面包' );
		const top = S.clay( 0.01, 0.1, 1, 1.05 ); await S.wait( 1500 );
		S.say( '🖌 撒点芝麻' );
		const seeds = [ [ - 0.3, 0.8, 0.4 ], [ 0.35, 0.85, 0.3 ], [ 0, 0.95, - 0.2 ], [ - 0.2, 0.85, - 0.35 ], [ 0.25, 0.8, - 0.4 ] ];
		for ( const s of seeds ) { S.dab( top, s[ 0 ], s[ 1 ], s[ 2 ], 2 ); await S.wait( 220 ); }
		await S.wait( 1400 );

	} },
	{ name: '瓢虫', run: async ( S ) => {

		S.say( '一颗红红的身体' );
		const bug = S.clay( 0, 0.3, 0, 1.15 ); await S.wait( 1300 );
		S.say( '🖌 点上斑点' );
		const spots = [ [ - 0.4, 0.7, 0.35 ], [ 0.45, 0.75, 0.25 ], [ 0, 0.9, - 0.15 ], [ - 0.45, 0.6, - 0.4 ], [ 0.4, 0.55, - 0.45 ], [ 0, 0.5, 0.75 ] ];
		for ( const s of spots ) { S.dab( bug, s[ 0 ], s[ 1 ], s[ 2 ], 5 ); await S.wait( 260 ); }
		S.say( '一对大眼睛' );
		S.eye( - 0.2, 0.62 ); await S.wait( 800 );
		S.eye( 0.22, 0.64 ); await S.wait( 1500 );

	} },
	{ name: '小房子', run: async ( S ) => {

		S.say( '摆四颗球' );
		const bricks = [];
		for ( const [ dx, dz ] of [ [ - 0.55, - 0.55 ], [ 0.55, - 0.55 ], [ - 0.55, 0.55 ], [ 0.55, 0.55 ] ] ) {

			bricks.push( S.clay( dx, dz, 1 ) );
			await S.wait( 800 );

		}
		S.say( '每颗按住变三下：变成方砖！' );
		for ( const b of bricks ) {

			S.morph( b ); await S.wait( 260 );
			S.morph( b ); await S.wait( 260 );
			S.morph( b ); await S.wait( 700 );

		}
		S.say( '顶上盖屋顶' );
		const roof = S.clay( 0, 0, 0 ); await S.wait( 1100 );
		S.morph( roof ); await S.wait( 1100 );
		S.say( '再加个尖顶烟囱～' );
		S.decor( 'hat', 0, - 0.05 );
		await S.wait( 1600 );

	} },
];

// ---------- 🧸 手办工坊：转盘台上搭 Q 版手办（无重力、精确放置） ----------

function rebuildWsBody() {

	const w = workshop;
	if ( ! w || ! wsStage ) return;
	if ( w.figureMesh ) {

		wsStage.figure.remove( w.figureMesh );
		w.figureMesh.geometry.dispose();

	}
	if ( ! w.bodyMat ) {

		w.bodyMat = new THREE.MeshPhysicalMaterial( {
			color: CLAY_COLORS[ w.colorIndex ],
			roughness: 0.58, clearcoat: 0.15, clearcoatRoughness: 0.5, envMapIntensity: 0.5,
		} );

	}
	const { mesh, y0 } = bakeBodyMesh( BODY_TEMPLATES[ w.tplIndex ], w.bodyMat );
	w.figureMesh = mesh;
	w.bakeY0 = y0;
	wsStage.figure.add( mesh );
	// 头套是按旧身体剪裁的，换身体后穿不上了——收回
	if ( w.parts ) {

		for ( const en of [ ...w.parts ] ) {

			if ( PARTS[ en.partId ].fitted ) wsDiscardEntry( en );

		}

	}
	markDirty();
	plop();

}

// ---------- 手办 ⇄ 存档/黏土板：同一份 figData 既是工坊存档也是板上手办的重建配方 ----------

const _num = ( v, d ) => ( Number.isFinite( + v ) ? + v : d );
const _ci = ( v ) => THREE.MathUtils.clamp( _num( v, 0 ) | 0, 0, CLAY_COLORS.length - 1 );

// 工坊当前手办 → 可序列化配方（无内容返回 null）
function wsFigData( w ) {

	if ( ! w || ! w.figureMesh ) return null;
	return {
		t: w.tplIndex, c: w.colorIndex,
		ps: w.parts.map( ( en ) => ( {
			p: en.partId, k: r3( en.k ), c: Math.max( 0, CLAY_COLORS.indexOf( en.colorHex ) ),
			lp: [ r3( en.lp.x ), r3( en.lp.y ), r3( en.lp.z ) ],
			ln: [ r3( en.ln.x ), r3( en.ln.y ), r3( en.ln.z ) ],
		} ) ),
	};

}

// 配方 → 黏土板上的手办：一块 kind:'figure' 刚体（每个模板球一个 sphere 碰撞体），
// 网格组挂在 rec.mesh 上由 syncEyes 通用同步。拖拽/弹跳/定型/焊接/拍短片全部照常适用
function createFigure( fd, x, baseY, z ) {

	if ( ! fd || balls.filter( ( r ) => r.kind === 'figure' ).length >= 4 ) { shakePalette(); return null; }

	const tpl = THREE.MathUtils.clamp( _num( fd.t, 0 ) | 0, 0, BODY_TEMPLATES.length - 1 );
	const template = BODY_TEMPLATES[ tpl ];
	const mat = new THREE.MeshPhysicalMaterial( {
		color: CLAY_COLORS[ _ci( fd.c ) ],
		roughness: 0.58, clearcoat: 0.15, clearcoatRoughness: 0.5, envMapIntensity: 0.5,
	} );
	const { mesh: bodyMesh, y0 } = bakeBodyMesh( template, mat );

	// 身高与中心：刚体原点放在半身高处，拾取球才罩得住整只
	let topY = 0;
	for ( const b of template.balls ) topY = Math.max( topY, b.o[ 1 ] + b.r - y0 );
	const cy = topY / 2;

	const inner = new THREE.Group();
	inner.position.y = - cy;
	inner.add( bodyMesh );
	const group = new THREE.Group();
	group.add( inner );

	for ( const pd of ( Array.isArray( fd.ps ) ? fd.ps : [] ).slice( 0, MAX_WS_PARTS ) ) {

		if ( ! pd || ! PARTS[ pd.p ] ) continue;
		const def = PARTS[ pd.p ];
		const colorHex = CLAY_COLORS[ _ci( pd.c ) ];
		const k = def.fitted ? 1 : THREE.MathUtils.clamp( _num( pd.k, 1 ), 0.45, 2 );
		const lp = def.fitted ? new THREE.Vector3() : new THREE.Vector3(
			THREE.MathUtils.clamp( _num( pd.lp && pd.lp[ 0 ], 0 ), - 3, 3 ),
			THREE.MathUtils.clamp( _num( pd.lp && pd.lp[ 1 ], 0 ), - 3, 3 ),
			THREE.MathUtils.clamp( _num( pd.lp && pd.lp[ 2 ], 0 ), - 3, 3 ) );
		const ln = def.fitted ? new THREE.Vector3( 0, 0, 1 ) : new THREE.Vector3(
			_num( pd.ln && pd.ln[ 0 ], 0 ), _num( pd.ln && pd.ln[ 1 ], 0 ), _num( pd.ln && pd.ln[ 2 ], 1 ) );
		if ( ln.lengthSq() < 1e-6 ) ln.set( 0, 0, 1 );
		ln.normalize();

		const place = ( px, nx ) => {

			const built = def.fitted
				? buildHoodPart( bodyMesh.geometry, template, y0, colorHex )
				: buildPart( pd.p, colorHex );
			built.group.position.set( px, lp.y, lp.z );
			_v.set( nx, ln.y, ln.z );
			built.group.quaternion.setFromUnitVectors( Z_OUT, _v );
			built.group.scale.setScalar( k );
			inner.add( built.group );

		};
		place( lp.x, ln.x );
		if ( def.paired && Math.abs( lp.x ) > 0.1 ) place( - lp.x, - ln.x );

	}

	scene.add( group );

	// 物理：每个模板球一个 sphere（复合形状撑起大致轮廓）；异常时退回单球
	const bd = b3.b3DefaultBodyDef();
	bd.type = b3.b3BodyType.b3_dynamicBody;
	bd.position = { x, y: baseY + cy, z };
	const body = b3.b3CreateBody( world, bd );
	const sd = b3.b3DefaultShapeDef();
	sd.baseMaterial.friction = 0.9;
	sd.baseMaterial.restitution = 0.05;
	let shape = null;
	try {

		for ( const b of template.balls ) {

			shape = b3.b3CreateSphereShape( body, sd, {
				center: { x: b.o[ 0 ], y: b.o[ 1 ] - y0 - cy, z: b.o[ 2 ] },
				radius: b.r * 0.92,
			} );

		}

	} catch ( err ) {

		console.warn( 'figure compound shape failed, fallback to single sphere:', err );
		shape = b3.b3CreateSphereShape( body, sd, { center: { x: 0, y: 0, z: 0 }, radius: cy } );

	}
	b3.b3Body_SetLinearDamping( body, 0.3 );
	b3.b3Body_SetAngularDamping( body, 0.6 );

	const rec = {
		id: nextId ++, kind: 'figure', body, shape, r: cy * 1.05, k: 1, color: null,
		mesh: group, alive: true, frozen: false, slowTicks: 0,
		bornAt: performance.now(), popAt: 0,
		figData: JSON.parse( JSON.stringify( fd ) ),
	};
	balls.push( rec );
	markDirty();
	plop();
	return rec;

}

// 从存档配方还原工坊里的半成品
function restoreWorkshop( fd ) {

	workshop = { tplIndex: THREE.MathUtils.clamp( _num( fd.t, 0 ) | 0, 0, BODY_TEMPLATES.length - 1 ), colorIndex: _ci( fd.c ), partColorIndex: 6, yaw: 0, yawVel: 0, bodyMat: null, figureMesh: null, parts: [], placing: null };
	rebuildWsBody();
	for ( const pd of ( Array.isArray( fd.ps ) ? fd.ps : [] ).slice( 0, MAX_WS_PARTS ) ) {

		if ( ! pd || ! PARTS[ pd.p ] ) continue;
		workshop.partColorIndex = _ci( pd.c );
		const en = wsAddPartEntry( pd.p );
		if ( ! en ) break;
		en.colorHex = CLAY_COLORS[ _ci( pd.c ) ];
		for ( const m of en.mats ) if ( en.role !== 'fixed' ) m.color.setHex( en.colorHex );
		if ( ! en.fitted ) {

			en.k = THREE.MathUtils.clamp( _num( pd.k, 1 ), 0.45, 2 );
			en.lp.set( _num( pd.lp && pd.lp[ 0 ], 0 ), _num( pd.lp && pd.lp[ 1 ], 0 ), _num( pd.lp && pd.lp[ 2 ], 0 ) ).clampScalar( - 3, 3 );
			en.ln.set( _num( pd.ln && pd.ln[ 0 ], 0 ), _num( pd.ln && pd.ln[ 1 ], 0 ), _num( pd.ln && pd.ln[ 2 ], 1 ) );
			if ( en.ln.lengthSq() < 1e-6 ) en.ln.set( 0, 0, 1 );
			en.ln.normalize();

		}
		applyWsPose( en );
		workshop.parts.push( en );

	}
	workshop.partColorIndex = 6;

}

function enterWorkshop() {

	if ( workshop ) return;
	commitTentative();
	cancelSession();
	stopDemo();
	saveScene();
	if ( ! wsStage ) wsStage = buildWorkshopStage( scene );
	if ( wsKeep ) {

		workshop = wsKeep;

	} else if ( wsSavedData ) {

		// 上次没捏完的：从存档接着来
		try { restoreWorkshop( wsSavedData ); } catch ( err ) { console.warn( 'ws restore failed:', err ); workshop = null; }
		wsSavedData = null;

	}
	if ( ! workshop ) workshop = { tplIndex: 0, colorIndex: 9, partColorIndex: 6, yaw: 0, yawVel: 0, bodyMat: null, figureMesh: null, parts: [], placing: null };
	if ( ! workshop.figureMesh ) rebuildWsBody();
	selectWsColor( workshop.colorIndex );
	document.getElementById( 'palette' ).classList.add( 'hidden' );
	document.getElementById( 'workshopBar' ).classList.remove( 'hidden' );
	document.body.classList.add( 'ws' );
	setHint( '🧸 手办工坊：货架上拖个部件按上去 · 拖一拖转圈看 · 点色块换颜色 · ⬅ 回黏土板' );

}

function exitWorkshop() {

	if ( ! workshop ) return;
	wsCancelPlace();
	workshop.placing = null;
	selectWsShelf( null );
	wsKeep = workshop; // 半成品留着，回来接着捏
	workshop = null;
	wsDrag = null;
	document.getElementById( 'palette' ).classList.remove( 'hidden' );
	document.getElementById( 'workshopBar' ).classList.add( 'hidden' );
	document.body.classList.remove( 'ws' );
	resetHint();

}

function selectWsColor( i ) {

	document.querySelectorAll( '#wsColorRow button' ).forEach( ( el, j ) => {

		el.classList.toggle( 'selected', j === i );

	} );

}

// ---------- 工坊部件放置：射线打在烘焙身体上，部件沿表面滑动，成对自动镜像 ----------

// 身体表面命中（figure 局部系）：点 + 平滑法线（面三顶点法线平均）
function wsSurfaceHit() {

	if ( ! workshop || ! workshop.figureMesh ) return null;
	// 穿了头套后部件长在头套表面上；脸开口处露出身体，命中自然回落到身体
	const targets = [ workshop.figureMesh ];
	for ( const en of workshop.parts ) {

		if ( en.fitted && ( ! wsPlace || wsPlace.entry !== en ) ) targets.push( en.mesh );

	}
	const hits = raycaster.intersectObjects( targets, false );
	if ( ! hits.length ) return null;
	const h = hits[ 0 ];
	const na = h.object.geometry.getAttribute( 'normal' );
	_v.set( 0, 0, 0 );
	for ( const idx of [ h.face.a, h.face.b, h.face.c ] ) _v.add( _v2.fromBufferAttribute( na, idx ) );
	_v.normalize();
	// 身体/头套在 figure 里都没有额外旋转：对象空间法线即 figure 局部法线
	return { lp: wsStage.figure.worldToLocal( h.point.clone() ), ln: _v.clone() };

}

// 新建部件条目（成对部件带镜像孪生）
function wsAddPartEntry( partId ) {

	if ( workshop.parts.length >= MAX_WS_PARTS ) { shakePalette(); return null; }
	const def = PARTS[ partId ];
	const colorHex = CLAY_COLORS[ def.role === 'own' ? workshop.partColorIndex : workshop.colorIndex ];

	// 头套：按当前身体现做现剪
	const a = def.fitted
		? buildHoodPart( workshop.figureMesh.geometry, BODY_TEMPLATES[ workshop.tplIndex ], workshop.bakeY0, colorHex )
		: buildPart( partId, colorHex );
	wsStage.figure.add( a.group );
	const entry = {
		partId, role: def.role, colorHex, k: 1, fitted: !! def.fitted,
		lp: new THREE.Vector3(), ln: new THREE.Vector3( 0, 0, 1 ),
		group: a.group, mesh: a.mesh, mats: [ ...a.mats ],
		twinGroup: null, twinMesh: null,
	};
	if ( def.paired ) {

		const b = buildPart( partId, colorHex );
		wsStage.figure.add( b.group );
		entry.twinGroup = b.group;
		entry.twinMesh = b.mesh;
		entry.mats.push( ...b.mats );

	}
	return entry;

}

function applyWsPose( en ) {

	en.group.position.copy( en.lp );
	en.group.quaternion.setFromUnitVectors( Z_OUT, en.ln );
	en.group.scale.setScalar( en.k );
	en.group.visible = true;
	if ( en.twinGroup ) {

		const show = Math.abs( en.lp.x ) > 0.1; // 贴着中线时不出孪生，免得叠在一起
		en.twinGroup.visible = show;
		if ( show ) {

			en.twinGroup.position.set( - en.lp.x, en.lp.y, en.lp.z );
			_v.set( - en.ln.x, en.ln.y, en.ln.z );
			en.twinGroup.quaternion.setFromUnitVectors( Z_OUT, _v );
			en.twinGroup.scale.setScalar( en.k );

		}

	}

}

function wsSetGhost( en, ghost ) {

	for ( const m of en.mats ) {

		m.transparent = ghost;
		m.opacity = ghost ? 0.72 : 1;
		m.needsUpdate = false;

	}

}

// 点到已放置的部件？（身体更近时让位给转盘拖拽）
function pickWsPart() {

	const hits = raycaster.intersectObject( wsStage.figure, true );
	for ( const h of hits ) {

		if ( h.object === workshop.figureMesh ) return null;
		if ( h.object.userData.isPart ) {

			for ( const en of workshop.parts ) {

				for ( let o = h.object; o && o !== wsStage.figure; o = o.parent ) {

					if ( o === en.group || o === en.twinGroup ) return en;

				}

			}

		}

	}
	return null;

}

function wsPlaceMoveTo( e ) {

	setRay( e );
	const en = wsPlace.entry;
	const hit = wsSurfaceHit();
	if ( hit ) {

		const def = PARTS[ en.partId ];
		if ( en.fitted ) {

			// 头套是合身的：指着身体就穿上（位姿固定），拖开才脱下
			en.lp.set( 0, 0, 0 );
			en.ln.set( 0, 0, 1 );
			en.k = 1;

		} else {

			if ( def.centerSnap && Math.abs( hit.lp.x ) < 0.16 ) hit.lp.x *= 0.25; // 中线软吸附（鼻子、肚兜放得正）
			en.ln.copy( hit.ln );
			en.lp.copy( hit.lp ).addScaledVector( hit.ln, - def.sink * en.k );

		}
		applyWsPose( en );
		wsPlace.valid = true;

	} else {

		en.group.visible = false;
		if ( en.twinGroup ) en.twinGroup.visible = false;
		wsPlace.valid = false;

	}

}

function wsPlacePointerMove( e ) {

	if ( ! wsPlace || ! workshop ) return;
	if ( wsPlace.pinch && e.pointerId === wsPlace.pinch.id2 ) {

		// 第二指：捏合调部件大小
		const d = Math.max( 1, Math.hypot( e.clientX - wsPlace.x, e.clientY - wsPlace.y ) );
		wsPlace.entry.k = THREE.MathUtils.clamp( wsPlace.pinch.startK * d / wsPlace.pinch.startDist, 0.45, 2 );
		applyWsPose( wsPlace.entry );
		return;

	}
	if ( e.pointerId !== wsPlace.id ) return;
	wsPlace.x = e.clientX; wsPlace.y = e.clientY;
	wsPlaceMoveTo( e );

}

function wsDiscardEntry( en ) {

	wsStage.figure.remove( en.group );
	if ( en.twinGroup ) wsStage.figure.remove( en.twinGroup );
	const i = workshop.parts.indexOf( en );
	if ( i >= 0 ) workshop.parts.splice( i, 1 );

}

function wsPlacePointerUp( e ) {

	if ( ! wsPlace ) return;
	if ( wsPlace.pinch && e.pointerId === wsPlace.pinch.id2 ) { wsPlace.pinch = null; return; }
	if ( e.pointerId !== wsPlace.id ) return;
	const en = wsPlace.entry;
	if ( wsPlace.valid ) {

		wsSetGhost( en, false );
		if ( ! workshop.parts.includes( en ) ) workshop.parts.push( en );
		markDirty(); // 半成品也进自动存档
		squish();

	} else {

		wsDiscardEntry( en ); // 拖离身体松手 = 收回这个部件
		markDirty();
		pop();

	}
	wsPlace = null;
	window.removeEventListener( 'pointermove', wsPlacePointerMove );
	window.removeEventListener( 'pointerup', wsPlacePointerUp );
	window.removeEventListener( 'pointercancel', wsPlacePointerUp );
	setHint( '🧸 手办工坊：货架上拖个部件按上去 · 拖住时加一指调大小 · 拖下来就收回' );

}

function beginWsPlace( e, entry, isNew ) {

	wsPlace = { id: e.pointerId, entry, isNew, valid: false, pinch: null, x: e.clientX, y: e.clientY };
	wsSetGhost( entry, true );
	window.addEventListener( 'pointermove', wsPlacePointerMove );
	window.addEventListener( 'pointerup', wsPlacePointerUp );
	window.addEventListener( 'pointercancel', wsPlacePointerUp );

}

function wsCancelPlace() {

	if ( wsShelf ) wsShelfCleanup();
	if ( ! wsPlace ) return;
	const en = wsPlace.entry;
	if ( wsPlace.valid ) {

		wsSetGhost( en, false );
		if ( ! workshop.parts.includes( en ) ) workshop.parts.push( en );

	} else {

		wsDiscardEntry( en );

	}
	wsPlace = null;
	window.removeEventListener( 'pointermove', wsPlacePointerMove );
	window.removeEventListener( 'pointerup', wsPlacePointerUp );
	window.removeEventListener( 'pointercancel', wsPlacePointerUp );

}

// 货架按钮：点一下 = 上膛（下一次按到身上就放），拖出来 = 直接开始放置
function wsShelfCleanup() {

	wsShelf = null;
	window.removeEventListener( 'pointermove', wsShelfMove );
	window.removeEventListener( 'pointerup', wsShelfUp );

}

function wsShelfMove( e ) {

	if ( ! wsShelf || e.pointerId !== wsShelf.id || ! workshop ) return;
	if ( Math.hypot( e.clientX - wsShelf.x0, e.clientY - wsShelf.y0 ) < 12 ) return;
	const partId = wsShelf.partId;
	wsShelfCleanup();
	selectWsShelf( null );
	workshop.placing = null;
	const entry = wsAddPartEntry( partId );
	if ( ! entry ) return;
	beginWsPlace( e, entry, true );
	wsPlaceMoveTo( e );

}

function wsShelfUp( e ) {

	if ( ! wsShelf || e.pointerId !== wsShelf.id ) return;
	// 没拖出去：保持上膛状态，等着按到身上
	wsShelfCleanup();

}

function selectWsShelf( partId ) {

	document.querySelectorAll( '#wsPartRow button' ).forEach( ( el ) => {

		el.classList.toggle( 'selected', el.dataset.part === partId );

	} );

}

// 工坊里的指针：部件放置优先，其次拿起已放置的部件，否则转转盘
function wsPointerMove( e ) {

	if ( ! wsDrag || e.pointerId !== wsDrag.id || ! workshop ) return;
	const dx = e.clientX - wsDrag.lastX;
	wsDrag.lastX = e.clientX;
	workshop.yaw += dx * 0.011;
	workshop.yawVel = THREE.MathUtils.clamp( dx * 0.011 * 60, - 8, 8 );

}

function wsPointerUp( e ) {

	if ( ! wsDrag || e.pointerId !== wsDrag.id ) return;
	wsDrag = null;
	window.removeEventListener( 'pointermove', wsPointerMove );
	window.removeEventListener( 'pointerup', wsPointerUp );
	window.removeEventListener( 'pointercancel', wsPointerUp );

}

function wsPointerDown( e ) {

	ensureAudio();

	// 放置中落第二指：进入捏合调大小
	if ( wsPlace ) {

		if ( e.pointerId !== wsPlace.id && ! wsPlace.pinch && ! wsPlace.entry.fitted ) {

			const d = Math.hypot( e.clientX - wsPlace.x, e.clientY - wsPlace.y );
			if ( d > 40 ) wsPlace.pinch = { id2: e.pointerId, startDist: d, startK: wsPlace.entry.k };

		}
		return;

	}
	if ( wsDrag ) return;
	setRay( e );

	// 货架上膛过：这一按就是放置
	if ( workshop.placing ) {

		const partId = workshop.placing;
		workshop.placing = null;
		selectWsShelf( null );
		const entry = wsAddPartEntry( partId );
		if ( ! entry ) return;
		beginWsPlace( e, entry, true );
		wsPlaceMoveTo( e );
		return;

	}

	// 点到已放置部件：拿起来重新放
	const picked = pickWsPart();
	if ( picked ) {

		beginWsPlace( e, picked, false );
		wsPlaceMoveTo( e );
		return;

	}

	wsDrag = { id: e.pointerId, lastX: e.clientX };
	window.addEventListener( 'pointermove', wsPointerMove );
	window.addEventListener( 'pointerup', wsPointerUp );
	window.addEventListener( 'pointercancel', wsPointerUp );

}

// 每帧的工坊/相机更新（animate 与 __clay.step 共用）
function frameUpdate( dt ) {

	if ( workshop && wsStage ) {

		if ( ! wsDrag ) {

			workshop.yaw += workshop.yawVel * dt;
			workshop.yawVel *= Math.pow( 0.03, dt ); // 松手后惯性滑行

		}
		wsStage.figure.rotation.y = workshop.yaw;

	}

	// 相机在黏土板与工坊之间缓动飞行 = 全屏转场
	const target = workshop ? 1 : 0;
	if ( camBlend !== target ) {

		camBlend += Math.sign( target - camBlend ) * Math.min( dt * 1.7, Math.abs( target - camBlend ) );
		if ( camBlend === 0 ) frameCamera(); // 回到板上，恢复精确机位

	}
	if ( camBlend > 0 ) {

		const t = camBlend * camBlend * ( 3 - 2 * camBlend ); // smoothstep
		_wsA.copy( WORKSHOP_POS ).add( WS_CAM_OFF );
		camera.position.lerpVectors( boardCamPos, _wsA, t );
		_wsB.copy( WORKSHOP_POS ).add( WS_LOOK_OFF );
		_wsA.set( 0, 0.7, 0 ).lerp( _wsB, t );
		camera.lookAt( _wsA );

	}

}

async function startDemo() {

	stopDemo();

	const recipe = DEMO_RECIPES[ demoIndex % DEMO_RECIPES.length ];
	demoIndex ++;
	const token = { name: recipe.name };
	demoRun = token; // 先立令牌再清场：demo 期间 saveScene 全部跳过，孩子的存档保留开演前的状态
	clearAll();

	// 中途被打断（用户碰画布/按钮）时 wait 会 reject，直接静默收场
	// 演示件一律用中号（kOverride=1），不受 ● 大小档影响，保证坐标稳定
	const S = {
		wait: ( ms ) => new Promise( ( resolve, reject ) => {

			demoWaiters.push( { token, target: stepCount + Math.max( 1, Math.round( ms * 0.06 ) ), resolve, reject } );

		} ),
		say: ( t ) => setHint( '🎬 ' + recipe.name + '：' + t ),
		clay: ( x, z, c, k ) => createClay( x, 3, z, c, null, k || 1 ),
		dab: ( rec, ox, oy, oz, ci ) => {

			if ( ! rec || ! rec.alive ) return;
			const p = b3.b3Body_GetPosition( rec.body );
			const len = Math.hypot( ox, oy, oz ) || 1;
			const r = ( rec.form === 0 ? CLAY_R_VIS : FORMS[ rec.form ].pickR * 0.85 ) * rec.k;
			addDabAt( rec, { x: p.x + ox / len * r, y: p.y + oy / len * r, z: p.z + oz / len * r }, ci );

		},
		chain: ( x, z, c ) => createChain( x, z, c, 1 ),
		decor: ( kind, x, z ) => createDecor( kind, x, 3, z ),
		eye: ( x, z ) => createDecor( 'eye', x, 3, z ),
		morph: ( rec ) => { if ( rec && rec.alive ) setForm( rec, ( rec.form + 1 ) % FORMS.length ); },
		pos: ( rec ) => ( rec && rec.alive ? b3.b3Body_GetPosition( rec.body ) : null ),
		poke: ( rec, ox, oy, oz ) => {

			if ( ! rec || ! rec.alive ) return;
			const p = b3.b3Body_GetPosition( rec.body );
			const len = Math.hypot( ox, oy, oz ) || 1;
			const r = rec.form === 0 ? CLAY_R_VIS : FORMS[ rec.form ].pickR * 0.85;
			addDentAt( rec, { x: p.x + ox / len * r, y: p.y + oy / len * r, z: p.z + oz / len * r } );

		},
	};

	try {

		await recipe.run( S );
		if ( demoRun === token ) {

			setHint( '🎬 轮到你啦！照着捏一个 →' );
			setTimeout( () => {

				if ( demoRun === token ) { demoRun = null; resetHint(); }

			}, 3500 );

		}

	} catch ( err ) {

		// demo-stopped：孩子接管了，安静退场

	}

}

// ---------- 🎥 作品短片：镜头环绕一圈，录成视频保存 ----------

let clipRec = null; // { recorder, t0, dur, dist, h }

function recordClip( dur ) {

	if ( clipRec || demoRun ) return;
	if ( ! ( 'MediaRecorder' in window ) || ! renderer.domElement.captureStream ) {

		setHint( '这个浏览器不支持录像，换 Chrome/Safari 新版试试' );
		setTimeout( resetHint, 2600 );
		return;

	}
	if ( ! balls.length ) {

		setHint( '先捏一个作品，再来拍片～' );
		setTimeout( resetHint, 2600 );
		return;

	}

	try {

		// captureStream(0) + requestFrame：渲染后显式喂帧，不依赖合成器节奏
		const stream = renderer.domElement.captureStream( 0 );
		// Chrome 优先 webm（成熟稳定），Safari 不支持 webm 时回退 mp4
		const mime = MediaRecorder.isTypeSupported( 'video/webm;codecs=vp9' ) ? 'video/webm;codecs=vp9'
			: MediaRecorder.isTypeSupported( 'video/webm' ) ? 'video/webm'
			: MediaRecorder.isTypeSupported( 'video/mp4' ) ? 'video/mp4' : '';
		if ( ! mime ) { setHint( '这个浏览器不支持录像' ); setTimeout( resetHint, 2600 ); return; }
		const recorder = new MediaRecorder( stream, { mimeType: mime, videoBitsPerSecond: 6e6 } );
		const chunks = [];
		recorder.ondataavailable = ( e ) => { if ( e.data.size ) chunks.push( e.data ); };
		recorder.onstop = () => {

			const blob = new Blob( chunks, { type: mime } );
			window.__clay.lastClipSize = blob.size;
			if ( blob.size < 2000 ) {

				setHint( '录像没拍到内容，再试一次？' );
				setTimeout( resetHint, 2600 );
				return;

			}
			const a = document.createElement( 'a' );
			a.href = URL.createObjectURL( blob );
			a.download = 'clay-' + Math.round( performance.now() ) + ( mime.startsWith( 'video/mp4' ) ? '.mp4' : '.webm' );
			a.click();
			setTimeout( () => URL.revokeObjectURL( a.href ), 5000 );
			setHint( '🎥 短片已保存！' );
			setTimeout( resetHint, 2600 );

		};
		recorder.start();
		clipRec = {
			recorder,
			track: stream.getVideoTracks()[ 0 ],
			t0: performance.now(),
			dur: dur || 5200,
			dist: camera.position.length(),
			h: camera.position.y,
		};
		setHint( '🎥 正在给作品拍片…别动，转一圈就好' );

	} catch ( err ) {

		console.warn( 'record failed:', err );
		setHint( '录像启动失败' );
		setTimeout( resetHint, 2600 );

	}

}

// 录制期间每帧驱动环绕镜头；结束后恢复原机位
function pushClipFrame() {

	if ( clipRec && clipRec.track && clipRec.track.requestFrame ) clipRec.track.requestFrame();

}

function clipCamera() {

	if ( ! clipRec ) return;
	const t = ( performance.now() - clipRec.t0 ) / clipRec.dur;
	if ( t >= 1 ) {

		try { clipRec.recorder.stop(); } catch ( err ) {}
		clipRec = null;
		frameCamera();
		return;

	}
	const a = t * Math.PI * 2;
	const r = Math.hypot( clipRec.dist * clipRec.dist - clipRec.h * clipRec.h ) ** 0.5 || clipRec.dist * 0.75;
	camera.position.set( Math.sin( a ) * r, clipRec.h, Math.cos( a ) * r );
	camera.lookAt( 0, 0.7, 0 );

}

// ---------- 音效（WebAudio 现场合成，无外部资源） ----------

let actx = null;
let noiseBuffer = null;
let lastSquishAt = 0;

function resumeAudio() {

	// iOS 来电/切后台会把 state 置成非标准的 'interrupted'，所以不能只判 'suspended'
	if ( actx && actx.state !== 'running' ) {

		const p = actx.resume();
		if ( p ) p.catch( () => {} );

	}

}

function ensureAudio() {

	userTouched = true; // 所有输入入口都会经过这里：从此允许覆盖 localStorage 存档

	if ( ! actx ) {

		const AC = window.AudioContext || window.webkitAudioContext;
		if ( ! AC ) return;
		actx = new AC();
		document.addEventListener( 'visibilitychange', () => {

			if ( ! document.hidden ) resumeAudio();

		} );

	}
	resumeAudio();

}

function tone( type, f0, f1, dur, gain ) {

	if ( ! actx ) return;
	const t = actx.currentTime;
	const osc = actx.createOscillator();
	const g = actx.createGain();
	osc.type = type;
	osc.frequency.setValueAtTime( f0, t );
	osc.frequency.exponentialRampToValueAtTime( f1, t + dur );
	g.gain.setValueAtTime( gain, t );
	g.gain.exponentialRampToValueAtTime( 0.001, t + dur );
	osc.connect( g ).connect( actx.destination );
	osc.start( t );
	osc.stop( t + dur );

}

function noiseBurst( f0, f1, dur, gain ) {

	if ( ! actx ) return;
	if ( ! noiseBuffer ) {

		noiseBuffer = actx.createBuffer( 1, actx.sampleRate * 0.2, actx.sampleRate );
		const data = noiseBuffer.getChannelData( 0 );
		for ( let i = 0; i < data.length; i ++ ) data[ i ] = Math.random() * 2 - 1;

	}
	const t = actx.currentTime;
	const srcN = actx.createBufferSource();
	srcN.buffer = noiseBuffer;
	const filter = actx.createBiquadFilter();
	filter.type = 'lowpass';
	filter.frequency.setValueAtTime( f0, t );
	filter.frequency.exponentialRampToValueAtTime( f1, t + dur );
	const g = actx.createGain();
	g.gain.setValueAtTime( gain, t );
	g.gain.exponentialRampToValueAtTime( 0.001, t + dur );
	srcN.connect( filter ).connect( g ).connect( actx.destination );
	srcN.start( t );
	srcN.stop( t + dur + 0.02 );

}

// 带 Q 值的带通噪声：湿润的“咕叽”质地
function bandBurst( f0, f1, dur, gain, q ) {

	if ( ! actx ) return;
	if ( ! noiseBuffer ) {

		noiseBuffer = actx.createBuffer( 1, actx.sampleRate * 0.2, actx.sampleRate );
		const data = noiseBuffer.getChannelData( 0 );
		for ( let i = 0; i < data.length; i ++ ) data[ i ] = Math.random() * 2 - 1;

	}
	const t = actx.currentTime;
	const srcN = actx.createBufferSource();
	srcN.buffer = noiseBuffer;
	srcN.loop = true;
	srcN.playbackRate.value = 0.9 + Math.random() * 0.25;
	const filter = actx.createBiquadFilter();
	filter.type = 'bandpass';
	filter.Q.value = q;
	filter.frequency.setValueAtTime( f0, t );
	filter.frequency.exponentialRampToValueAtTime( f1, t + dur );
	const g = actx.createGain();
	g.gain.setValueAtTime( gain, t );
	g.gain.exponentialRampToValueAtTime( 0.001, t + dur );
	srcN.connect( filter ).connect( g ).connect( actx.destination );
	srcN.start( t );
	srcN.stop( t + dur + 0.02 );

}

function jitter( v, pct ) {

	return v * ( 1 + ( Math.random() * 2 - 1 ) * pct );

}

// 剪刀：两声干脆的“咔嚓”
function snip() {

	tone( 'square', 1250, 720, 0.035, 0.07 );
	setTimeout( () => tone( 'square', 950, 520, 0.04, 0.07 ), 45 );

}

// 上色：极轻的一点
function dabTick() {

	tone( 'sine', jitter( 620, 0.15 ), 380, 0.05, 0.07 );

}

// 落下：低频“咚”的肉感 + 短促的“啪”
function plop() {

	tone( 'sine', jitter( 200, 0.15 ), 85, jitter( 0.12, 0.2 ), 0.3 );
	noiseBurst( jitter( 650, 0.2 ), 180, 0.06, 0.09 );

}

// 弹跳：欢快的上滑 + 一点弹簧尾音
function boing() {

	const f1 = jitter( 480, 0.12 );
	tone( 'sine', 170, f1, 0.11, 0.16 );
	tone( 'sine', f1, f1 * 0.8, 0.07, 0.06 );

}

// 拆开：湿黏的“啵”
function pop() {

	tone( 'triangle', jitter( 280, 0.15 ), 850, 0.07, 0.13 );
	bandBurst( 1400, 500, jitter( 0.07, 0.2 ), 0.1, 3 );

}

// 黏合/揉捏：双层带通噪声的“咕叽”+ 低频顿感
function squish() {

	if ( ! actx ) return;
	const now = performance.now();
	if ( now - lastSquishAt < 80 ) return;
	lastSquishAt = now;
	bandBurst( jitter( 950, 0.2 ), 240, jitter( 0.16, 0.25 ), 0.2, 2.2 );
	bandBurst( jitter( 2100, 0.2 ), 600, 0.09, 0.05, 5 );
	tone( 'sine', jitter( 140, 0.15 ), 70, 0.07, 0.12 );

}

// ---------- 主循环 ----------

let acc = 0;
let lastT = performance.now();

function animate() {

	const now = performance.now();
	const dt = Math.min( ( now - lastT ) / 1000, 1 / 30 );
	lastT = now;
	acc += dt;

	// 工坊里不推物理（板上作品都定型睡着了），省下整份 CPU
	if ( workshop ) {

		acc = 0;

	} else {

		while ( acc >= STEP ) {

			dragControl();
			b3.b3World_Step( world, STEP, 4 );
			stepCount ++;
			if ( stepCount % 6 === 0 ) stickyPass();
			if ( stepCount % 15 === 0 ) freezePass();
			if ( stepCount % 30 === 0 ) rescuePass();
			acc -= STEP;

		}

	}

	pumpDemoWaiters();
	clipCamera();
	frameUpdate( dt );
	syncEyes();
	rebuildClay();
	renderer.render( scene, camera );
	pushClipFrame();

}

// ---------- 调试钩子（也算控制台小彩蛋） ----------

window.__clay = {
	state: () => ( {
		balls: balls.map( ( r ) => {

			const p = b3.b3Body_GetPosition( r.body );
			return { id: r.id, kind: r.kind, form: r.form, k: r.k, frozen: !! r.frozen, dents: r.dents ? r.dents.length : 0, x: + p.x.toFixed( 2 ), y: + p.y.toFixed( 2 ), z: + p.z.toFixed( 2 ), awake: b3.b3Body_IsAwake( r.body ) };

		} ),
		joints: joints.length,
		sticky: stickyEnabled,
	} ),
	spawn: ( x, z, c ) => createClay( x, 3, z, c === undefined ? selected : c ),
	chain: ( x, z, c ) => createChain( x, z, c === undefined ? selected : c ),
	size: ( i ) => { sizeIndex = Math.max( 0, Math.min( SIZES.length - 1, i ) ); return SIZES[ sizeIndex ]; },
	demo: ( i ) => { if ( i !== undefined ) demoIndex = i; startDemo(); },
	eye: ( x, z ) => createDecor( 'eye', x, 3, z ),
	decor: ( kind, x, z ) => createDecor( kind, x, 3, z ),
	morph: ( id ) => {

		const rec = balls.find( ( r ) => r.id === id );
		if ( rec ) setForm( rec, ( rec.form + 1 ) % FORMS.length );
		return rec ? rec.form : null;

	},
	cut: ( id ) => {

		const rec = balls.find( ( r ) => r.id === id );
		if ( rec ) cutPiece( rec );
		return balls.length;

	},
	dab: ( id, ox, oy, oz, ci ) => {

		const rec = balls.find( ( r ) => r.id === id );
		if ( ! rec || rec.kind !== 'clay' ) return null;
		const p = b3.b3Body_GetPosition( rec.body );
		const len = Math.hypot( ox, oy, oz ) || 1;
		const r = rec.form === 0 ? CLAY_R_VIS * rec.k : FORMS[ rec.form ].pickR * 0.85 * rec.k;
		addDabAt( rec, { x: p.x + ox / len * r, y: p.y + oy / len * r, z: p.z + oz / len * r }, ci === undefined ? selected : ci, sizeIndex );
		return rec.dents.length;

	},
	poke: ( id, ox, oy, oz ) => {

		const rec = balls.find( ( r ) => r.id === id );
		if ( ! rec || rec.kind !== 'clay' ) return null;
		const p = b3.b3Body_GetPosition( rec.body );
		// 只取方向，落点归一化到视觉表面（与 kneadHit 的手势路径一致）
		const len = Math.hypot( ox, oy, oz ) || 1;
		const r = rec.form === 0 ? CLAY_R_VIS : FORMS[ rec.form ].pickR * 0.85;
		addDentAt( rec, { x: p.x + ox / len * r, y: p.y + oy / len * r, z: p.z + oz / len * r } );
		return rec.dents.length;

	},
	clear: () => clearAll(),
	clip: ( ms ) => recordClip( ms ),
	save: () => { saveScene(); return location.href; },
	load: ( data ) => loadScene( typeof data === 'string' ? JSON.parse( data ) : data ),
	dump: () => serializeScene(),
	raw: () => ( { b3, world, effect, balls, FORMS } ),
	dragInfo: () => ( drag ? { id: drag.rec.id, target: drag.target.toArray(), quat: drag.targetQuat.toArray() } : null ),
	// 🧸 工坊开关与状态（测试用）
	ws: () => { workshop ? exitWorkshop() : enterWorkshop(); return ! ! workshop; },
	wsState: () => ( workshop ? {
		tpl: workshop.tplIndex, ci: workshop.colorIndex, yaw: + workshop.yaw.toFixed( 2 ), blend: + camBlend.toFixed( 2 ),
		placing: workshop.placing,
		parts: workshop.parts.map( ( en ) => ( { p: en.partId, k: + en.k.toFixed( 2 ), x: + en.lp.x.toFixed( 2 ), y: + en.lp.y.toFixed( 2 ), z: + en.lp.z.toFixed( 2 ), twin: !! ( en.twinGroup && en.twinGroup.visible ) } ) ),
	} : { blend: + camBlend.toFixed( 2 ) } ),
	// 工坊 Stage 1 验证：烘焙身体模板并摆到盘中央看效果/耗时
	bake: ( i = 0, res = 88 ) => {

		if ( window.__bakePreview ) scene.remove( window.__bakePreview );
		const tpl = BODY_TEMPLATES[ i % BODY_TEMPLATES.length ];
		const mat = new THREE.MeshPhysicalMaterial( {
			color: CLAY_COLORS[ ( i + 9 ) % CLAY_COLORS.length ],
			roughness: 0.58, clearcoat: 0.15, clearcoatRoughness: 0.5, envMapIntensity: 0.5,
		} );
		const { mesh, ms, tris } = bakeBodyMesh( tpl, mat, res );
		mesh.position.set( 0, 0.02, 0 );
		scene.add( mesh );
		window.__bakePreview = mesh;
		renderer.render( scene, camera );
		return { name: tpl.name, res, ms: Math.round( ms * 10 ) / 10, tris };

	},
	project: ( x, y, z ) => {

		const v = new THREE.Vector3( x, y, z ).project( camera );
		return { x: ( v.x + 1 ) / 2 * innerWidth, y: ( - v.y + 1 ) / 2 * innerHeight };

	},
	// 手动推进模拟（rAF 被节流的环境下用于调试/测试）
	step: ( n = 60 ) => {

		for ( let i = 0; i < n; i ++ ) {

			dragControl();
			b3.b3World_Step( world, STEP, 4 );
			stepCount ++;
			if ( stepCount % 6 === 0 ) stickyPass();
			if ( stepCount % 15 === 0 ) freezePass();
			if ( stepCount % 30 === 0 ) rescuePass();

		}
		pumpDemoWaiters();
		clipCamera();
		frameUpdate( n * STEP );
		syncEyes();
		markDirty();
		rebuildClay();
		renderer.render( scene, camera );
		pushClipFrame();
		return window.__clay.state();

	},
};

// ---------- 启动 ----------

init().then( () => {

	const loading = document.getElementById( 'loading' );
	loading.classList.add( 'hidden' );
	setTimeout( () => loading.remove(), 600 );

} ).catch( ( err ) => {

	console.error( err );
	const loading = document.getElementById( 'loading' );
	if ( loading ) loading.textContent = '出错了：' + ( err && err.message ? err.message : err );

} );
