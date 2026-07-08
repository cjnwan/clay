import * as THREE from 'three';
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js';
import Box3D from 'box3d.js/inline';

// ---------- 常量 ----------

const COARSE = matchMedia( '(pointer: coarse)' ).matches;

const BOARD_HALF = 2.6;          // 黏土盘半径（物理围墙内侧）
const FIELD_S = 3.4;             // metaball 场半尺寸：世界 x/z ∈ [-S,S]，y ∈ [0,2S]
const RES = COARSE ? 36 : 44;    // marching cubes 分辨率（触屏设备多为移动端，降一档）
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
const CLAY_COLORS = [ 0xe0584b, 0xf2a34d, 0xf6d155, 0x7dbb5f, 0x53a7dd, 0xa06bc9 ];
const BG = 0xefe0c8;
const FIELD_Y0 = - 0.2;          // 场底比桌面低一点，黏土底部才不会被切出开口，还有“压扁”效果
const DETACH_COOLDOWN = 1500;    // 双击拆开后这对球多久内不再自动黏回（毫秒）
const MORPH_HOLD_MS = 500;       // 按住多久开始变形 / 每级变形间隔
const MAX_DENTS = 10;            // 每块黏土最多保留的凹坑数，满了顶掉最旧的
const DENT_R = 0.3;              // 凹坑雕刻半径（负球在已有场里有效范围偏小，取大一点）
const DENT_STEP = 0.2;           // 划动捏坑时相邻坑的最小间距（世界单位）

// 黏土形态：按住循环切换。sub = metaball 子球（局部偏移 + 视觉半径，strength 在 init 里算）
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
];

// 贴件：r = 物理球半径，out = 焊到圆球黏土上时中心到黏土视觉表面的外推量
const DECOR = {
	eye: { r: EYE_R, out: EYE_R * 0.5 },
	mouth: { r: 0.12, out: 0.04 },
	hat: { r: 0.22, out: 0.06 },
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
let drag = null;                 // { rec, target: Vector3 }
let session = null;              // 当前指针会话
let lastTap = { rec: null, t: 0 };
let pendingHop = null;           // { rec, timer }：单击的跳跃延迟到双击窗口之后
let kneading = false;            // 🤏 捏捏模式
let dentStrength = 0;            // 凹坑负 metaball 强度（init 里按 isolation 算）
let stickyEnabled = true;
let demoRun = null;              // 🎬 表演模式的运行令牌（置 null 即中止）
let demoIndex = 0;
let demoArmedAt = 0;             // 有作品时需要 2.5s 内再点一次确认
let hintEl = null;
let defaultHint = '';

const KNEAD_HINT = '🤏 在黏土上按一按、划一划就能捏出坑 · 再点 🤏 收手';

function setHint( text ) {

	if ( hintEl ) hintEl.textContent = text;

}

function resetHint() {

	setHint( kneading ? KNEAD_HINT : defaultHint );

}
let stepCount = 0;
let lastDirty = 0;
let builtOnce = false;

const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
const UP = new THREE.Vector3( 0, 1, 0 );

// 复用对象，避免每帧分配
const _plane = new THREE.Plane();
const _v = new THREE.Vector3();
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

	camera = new THREE.PerspectiveCamera( 40, innerWidth / innerHeight, 0.1, 60 );
	frameCamera();

	// 灯光：柔和天光 + 一盏投影主灯，黏土要的是软阴影
	scene.add( new THREE.HemisphereLight( 0xfff6e8, 0xc9b391, 1.1 ) );

	const sun = new THREE.DirectionalLight( 0xffffff, 2.2 );
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

	// 黏土盘（视觉）
	const board = new THREE.Mesh(
		new THREE.CylinderGeometry( BOARD_HALF + 1.2, BOARD_HALF + 1.5, 0.5, 64 ),
		new THREE.MeshStandardMaterial( { color: 0xead9bd, roughness: 0.95 } )
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

	// metaball 黏土：逐球颜色 + 高粗糙度 = 橡皮泥质感
	const clayMaterial = new THREE.MeshStandardMaterial( { roughness: 0.7, metalness: 0, vertexColors: true } );
	effect = new MarchingCubes( RES, clayMaterial, false, true, 100000 );
	effect.position.set( 0, FIELD_S + FIELD_Y0, 0 );
	effect.scale.set( FIELD_S, FIELD_S, FIELD_S );
	effect.castShadow = true;
	effect.receiveShadow = true;
	scene.add( effect );

	// 各形态 metaball 子球的强度（依赖 effect.isolation，所以放在 effect 创建之后）
	for ( const f of FORMS ) {

		for ( const s of f.sub ) s.strength = strengthFor( s.r );

	}
	dentStrength = strengthFor( DENT_R );

	// 贴件的共享几何/材质与构造器。约定：网格的 +Z 朝外（焊接时转向黏土外侧）
	{
		const eyeWhiteGeo = new THREE.SphereGeometry( EYE_R, 24, 16 );
		const eyePupilGeo = new THREE.SphereGeometry( EYE_R * 0.5, 16, 12 );
		const eyeWhiteMat = new THREE.MeshStandardMaterial( { color: 0xffffff, roughness: 0.35 } );
		const eyePupilMat = new THREE.MeshStandardMaterial( { color: 0x2b2420, roughness: 0.3 } );

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
		const hatTrimMat = new THREE.MeshStandardMaterial( { color: 0xfff2dd, roughness: 0.7 } );

		decorBuilders.hat = () => {

			const g = new THREE.Group();
			const cone = new THREE.Mesh( coneGeo, hatMat );
			cone.rotation.x = Math.PI / 2; // 锥轴从 +Y 转到 +Z
			cone.position.z = 0.25;
			cone.castShadow = true;
			const brim = new THREE.Mesh( brimGeo, hatTrimMat );
			const pom = new THREE.Mesh( pomGeo, hatTrimMat );
			pom.position.z = 0.52;
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

	// 开场先丢三团进来
	createClay( - 0.9, 3.0, 0.2, 0 );
	createClay( 0.1, 3.8, - 0.4, 4 );
	createClay( 0.9, 4.6, 0.4, 2 );

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

	return rec.kind === 'clay' ? FORMS[ rec.form ].pickR : Math.max( rec.r * 1.6, 0.3 );

}

function stickRadiusOf( rec ) {

	return rec.kind === 'clay' ? FORMS[ rec.form ].stickR : rec.r;

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

function createClay( x, y, z, colorIndex, vel ) {

	if ( clayCount() >= MAX_CLAY ) { shakePalette(); return null; }

	const { body, shape } = createBallBody( x, y, z, CLAY_R, 0.9, 0.05 );
	if ( vel ) b3.b3Body_SetLinearVelocity( body, vel );

	const rec = {
		id: nextId ++,
		kind: 'clay',
		body,
		shape,
		form: 0,
		dents: [],
		r: CLAY_R,
		color: new THREE.Color( CLAY_COLORS[ colorIndex ] ),
		mesh: null,
		alive: true,
	};
	balls.push( rec );
	markDirty();
	plop();
	return rec;

}

function createDecor( kind, x, y, z ) {

	if ( decorCount() >= MAX_DECOR ) { shakePalette(); return null; }

	const spec = DECOR[ kind ];
	const { body, shape } = createBallBody( x, y, z, spec.r, 0.8, 0.1 );

	const mesh = decorBuilders[ kind ]();
	scene.add( mesh );

	const rec = { id: nextId ++, kind, body, shape, r: spec.r, color: null, mesh, alive: true };
	balls.push( rec );
	markDirty();
	plop();
	return rec;

}

// 按住黏土变形：圆球 → 压扁 → 搓长。物理形状同步替换，metaball 子球在 rebuildClay 里按形态渲染
function setForm( rec, form ) {

	if ( rec.kind !== 'clay' || form === rec.form || ! rec.alive ) return;

	detach( rec, true ); // 变形前先拆开，冷却结束后原地重新黏上

	const sd = b3.b3DefaultShapeDef();
	sd.baseMaterial.friction = 0.9;
	sd.baseMaterial.restitution = 0.05;

	try {

		b3.b3DestroyShape( rec.shape, true );

		if ( form === 1 ) {

			// 手工构居中的圆盘 hull：b3CreateCylinder 生成的 hull 底面在原点（y ∈ [0, h]），不居中
			const pts = [];
			for ( let i = 0; i < 12; i ++ ) {

				const a = ( i / 12 ) * Math.PI * 2;
				const px = Math.cos( a ) * 0.55, pz = Math.sin( a ) * 0.55;
				pts.push( px, - 0.18, pz, px, 0.18, pz );

			}
			const hull = b3.b3CreateHull( new Float32Array( pts ) );
			if ( ! hull ) throw new Error( 'disc hull failed' );
			rec.shape = b3.b3CreateHullShape( rec.body, sd, hull );
			hull.delete();

		} else if ( form === 2 ) {

			rec.shape = b3.b3CreateCapsuleShape( rec.body, sd, {
				center1: { x: - 0.42, y: 0, z: 0 },
				center2: { x: 0.42, y: 0, z: 0 },
				radius: 0.34,
			} );

		} else {

			rec.shape = b3.b3CreateSphereShape( rec.body, sd, { center: { x: 0, y: 0, z: 0 }, radius: CLAY_R } );

		}

		rec.form = form;

	} catch ( err ) {

		// 形状 API 出问题时退回圆球，别让 body 裸奔
		console.warn( 'setForm failed, fallback to ball:', err );
		rec.shape = b3.b3CreateSphereShape( rec.body, sd, { center: { x: 0, y: 0, z: 0 }, radius: CLAY_R } );
		rec.form = 0;

	}

	rec.dents.length = 0; // 重新揉过，旧坑抹平
	b3.b3Body_SetAwake( rec.body, true );
	markDirty();
	squish();

}

// 在世界点 wp 处给黏土捏一个坑（存局部坐标，跟着刚体转）
function addDentAt( rec, wp ) {

	const p = b3.b3Body_GetPosition( rec.body );
	const q = b3.b3Body_GetRotation( rec.body );
	_q.set( q.v.x, q.v.y, q.v.z, q.s ).invert();
	const lp = new THREE.Vector3( wp.x - p.x, wp.y - p.y, wp.z - p.z ).applyQuaternion( _q );

	// 把落点压到该形态的表面内侧一点：负球只有咬进等值面内才有可见效果
	if ( rec.form === 1 ) {

		// 圆盘：厚度方向压到皮下，径向不出边
		lp.y = THREE.MathUtils.clamp( lp.y, - 0.18, 0.18 );
		const r = Math.hypot( lp.x, lp.z );
		if ( r > 0.5 ) { const s = 0.5 / r; lp.x *= s; lp.z *= s; }

	} else if ( rec.form === 2 ) {

		// 香肠：轴向夹在两端内，径向压到皮下
		lp.x = THREE.MathUtils.clamp( lp.x, - 0.7, 0.7 );
		const r = Math.hypot( lp.y, lp.z );
		if ( r > 0.28 ) { const s = 0.28 / r; lp.y *= s; lp.z *= s; }

	} else {

		const len = lp.length();
		if ( len > 0.001 ) lp.multiplyScalar( Math.max( 0, len - 0.14 ) / len );

	}
	rec.dents.push( [ lp.x, lp.y, lp.z ] );
	if ( rec.dents.length > MAX_DENTS ) rec.dents.shift();
	markDirty();
	squish();

}

// 捏捏模式下取指针射线与黏土“表面”的近似交点（用视觉包围球代替等值面）
function kneadHit( rec, out ) {

	const p = b3.b3Body_GetPosition( rec.body );
	_sphere.center.set( p.x, p.y, p.z );
	_sphere.radius = rec.form === 0 ? CLAY_R_VIS : FORMS[ rec.form ].pickR * 0.85;
	return raycaster.ray.intersectSphere( _sphere, out );

}

function clearAll() {

	drag = null;
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

function weld( a, b, key ) {

	try {

		// 贴件（眼/嘴/帽）焊上去之前：+Z 转向外侧；圆球黏土还把它推到视觉表面之外，避免被 metaball 吞没
		const dec = a.kind !== 'clay' ? a : ( b.kind !== 'clay' ? b : null );
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

					const dist = CLAY_R_VIS + DECOR[ dec.kind ].out;
					pos = { x: po.x + _v.x * dist, y: po.y + _v.y * dist, z: po.z + _v.z * dist };

				}
				b3.b3Body_SetTransform( dec.body, pos, { v: { x: _q.x, y: _q.y, z: _q.z }, s: _q.w } );
				b3.b3Body_SetAngularVelocity( dec.body, { x: 0, y: 0, z: 0 } );

			}

		}

		const pa = b3.b3Body_GetPosition( a.body );
		const pb = b3.b3Body_GetPosition( b.body );
		const qa = b3.b3Body_GetRotation( a.body );
		const qb = b3.b3Body_GetRotation( b.body );
		const mid = { x: ( pa.x + pb.x ) / 2, y: ( pa.y + pb.y ) / 2, z: ( pa.z + pb.z ) / 2 };

		const def = b3.b3DefaultWeldJointDef();
		def.base.bodyIdA = a.body;
		def.base.bodyIdB = b.body;
		def.base.localFrameA = localFrame( pa, qa, mid );
		def.base.localFrameB = localFrame( pb, qb, mid );

		const joint = b3.b3CreateWeldJoint( world, def );
		joints.push( { joint, aId: a.id, bId: b.id, key } );
		weldedKeys.add( key );
		squish();

	} catch ( err ) {

		// 关节 API 不可用时退化为普通碰撞，游戏仍可玩
		stickyEnabled = false;
		console.warn( 'weld joint failed, sticky disabled:', err );

	}

}

function detach( rec, quiet ) {

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

// 每隔几步做一次 O(n²) 邻近检查：慢速贴着的黏土互相焊住（球数上限很小，代价可忽略）
function stickyPass() {

	if ( ! stickyEnabled ) return;

	for ( let i = 0; i < balls.length; i ++ ) {

		for ( let j = i + 1; j < balls.length; j ++ ) {

			const a = balls[ i ], b = balls[ j ];
			if ( a.kind !== 'clay' && b.kind !== 'clay' ) continue; // 贴件之间不互黏

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

// 沿焊接关节求连通团：拖一个球时整个作品一起走
function clusterOf( rec ) {

	const seen = new Set( [ rec.id ] );
	const list = [ rec ];
	let changed = true;
	while ( changed ) {

		changed = false;
		for ( const j of joints ) {

			const hasA = seen.has( j.aId ), hasB = seen.has( j.bId );
			if ( hasA === hasB ) continue;
			const otherId = hasA ? j.bId : j.aId;
			const other = balls.find( ( b ) => b.id === otherId );
			if ( other ) { seen.add( otherId ); list.push( other ); changed = true; }

		}

	}
	return list;

}

function dragControl() {

	if ( ! drag || ! drag.rec.alive ) return;

	const p = b3.b3Body_GetPosition( drag.rec.body );
	let vx = ( drag.target.x - p.x ) * 14;
	let vy = ( drag.target.y - p.y ) * 14;
	let vz = ( drag.target.z - p.z ) * 14;
	const len = Math.hypot( vx, vy, vz );
	if ( len > 20 ) { const s = 20 / len; vx *= s; vy *= s; vz *= s; }
	const v = { x: vx, y: vy, z: vz };

	for ( const rec of clusterOf( drag.rec ) ) {

		b3.b3Body_SetLinearVelocity( rec.body, v );
		const av = b3.b3Body_GetAngularVelocity( rec.body );
		b3.b3Body_SetAngularVelocity( rec.body, { x: av.x * 0.8, y: av.y * 0.8, z: av.z * 0.8 } );
		b3.b3Body_SetAwake( rec.body, true );

	}

}

function hop( rec ) {

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
	for ( const rec of balls ) {

		if ( rec.kind !== 'clay' ) continue;
		const p = b3.b3Body_GetPosition( rec.body );
		const form = FORMS[ rec.form ];
		const rotated = form.sub.length > 1 || rec.dents.length > 0;

		if ( rotated ) {

			const q = b3.b3Body_GetRotation( rec.body );
			_q.set( q.v.x, q.v.y, q.v.z, q.s );

		}

		if ( form.sub.length === 1 ) {

			addFieldBall( p.x, p.y, p.z, form.sub[ 0 ].strength, rec.color );

		} else {

			// 子球局部偏移跟随刚体旋转
			for ( const sub of form.sub ) {

				_v.set( sub.o[ 0 ], sub.o[ 1 ], sub.o[ 2 ] ).applyQuaternion( _q );
				addFieldBall( p.x + _v.x, p.y + _v.y, p.z + _v.z, sub.strength, rec.color );

			}

		}

		// 凹坑：负强度 metaball 做减法雕刻
		for ( const d of rec.dents ) {

			_v.set( d[ 0 ], d[ 1 ], d[ 2 ] ).applyQuaternion( _q );
			addFieldBall( p.x + _v.x, p.y + _v.y, p.z + _v.z, - dentStrength, rec.color );

		}

	}
	effect.update();
	builtOnce = true;

}

function syncEyes() {

	for ( const rec of balls ) {

		if ( ! rec.mesh ) continue;
		const p = b3.b3Body_GetPosition( rec.body );
		const q = b3.b3Body_GetRotation( rec.body );
		rec.mesh.position.set( p.x, p.y, p.z );
		rec.mesh.quaternion.set( q.v.x, q.v.y, q.v.z, q.s );

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

	// 起点就是当前位置：短按不预抬，免得单击时球被“拽”一下
	const p = b3.b3Body_GetPosition( rec.body );
	drag = { rec, target: new THREE.Vector3( p.x, p.y, p.z ) };
	b3.b3Body_SetAwake( rec.body, true );

}

function onPointerMove( e ) {

	if ( ! session || e.pointerId !== session.pointerId ) return;

	if ( Math.hypot( e.clientX - session.x0, e.clientY - session.y0 ) > ( session.type === 'palette' ? 10 : 6 ) ) {

		session.moved = true;

	}

	setRay( e );

	// 捏捏：沿划动路径隔一小段捏一个坑
	if ( session.type === 'knead' ) {

		if ( session.rec.alive && kneadHit( session.rec, _v ) ) {

			if ( ! session.lastDent || _v.distanceTo( session.lastDent ) > DENT_STEP ) {

				addDentAt( session.rec, _v );
				session.lastDent = _v.clone();

			}

		}
		return;

	}

	// 从调色盘拖出来：第一次移动时才真正生成
	if ( session.type === 'palette' && session.moved && session.pending ) {

		if ( rayPlaneY( LIFT_Y, _v ) ) {

			clampPlay( _v, 0.4 );
			const rec = session.kind === 'clay'
				? createClay( _v.x, LIFT_Y, _v.z, session.colorIndex )
				: createDecor( session.kind, _v.x, LIFT_Y, _v.z );
			session.pending = false;
			if ( rec ) {

				session.type = 'ball';
				session.rec = rec;
				drag = { rec, target: _v.clone() };

			}

		}
		return;

	}

	if ( drag && session.rec ) {

		if ( rayPlaneY( LIFT_Y, _v ) ) {

			clampPlay( _v, 0.35 );
			drag.target.set( _v.x, LIFT_Y, _v.z );

		}

	}

}

function onPointerUp( e ) {

	if ( ! session || e.pointerId !== session.pointerId ) return;
	const dt = performance.now() - session.t0;

	if ( session.type === 'ball' && session.rec ) {

		if ( ! session.moved && dt < 300 && session.rec.alive ) {

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
		drag = null;

	} else if ( session.type === 'table' ) {

		// 双击窗口内不在桌面生成新球——那多半是第二击落空了
		if ( ! session.moved && dt < 400 && session.spawn && performance.now() - lastTap.t > 350 ) {

			createClay( session.spawn.x, 2.8 + Math.random() * 0.6, session.spawn.z, selected, { x: 0, y: - 2, z: 0 } );

		}

	} else if ( session.type === 'palette' && session.pending && ! session.moved ) {

		// 点一下调色盘：随机丢一颗进来
		const rx = ( Math.random() - 0.5 ) * 1.6, rz = ( Math.random() - 0.5 ) * 1.6;
		if ( session.kind === 'clay' ) createClay( rx, 3.4, rz, session.colorIndex );
		else createDecor( session.kind, rx, 3.4, rz );

	}

	endSession();

}

function onPointerCancel( e ) {

	if ( ! session || e.pointerId !== session.pointerId ) return;
	drag = null;
	endSession();

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
	session = null;
	window.removeEventListener( 'pointermove', onPointerMove );
	window.removeEventListener( 'pointerup', onPointerUp );
	window.removeEventListener( 'pointercancel', onPointerCancel );

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

	canvas.addEventListener( 'pointerdown', ( e ) => {

		if ( session ) return;
		ensureAudio();
		stopDemo();
		setRay( e );

		const rec = pickBall();

		// 🤏 捏捏模式：按在黏土上是捏坑，不是拖拽
		if ( kneading && rec && rec.kind === 'clay' ) {

			beginSession( { type: 'knead', rec, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: false, lastDent: null } );
			if ( kneadHit( rec, _v ) ) {

				addDentAt( rec, _v );
				session.lastDent = _v.clone();

			}
			return;

		}

		if ( rec ) {

			beginSession( { type: 'ball', rec, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: false } );
			startDrag( rec );
			if ( rec.kind === 'clay' ) armMorphHold( session );

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

	const palette = document.getElementById( 'palette' );
	const eyeBtn = document.getElementById( 'eyeBtn' );

	CLAY_COLORS.forEach( ( c, i ) => {

		const btn = document.createElement( 'button' );
		btn.className = 'color';
		btn.style.background = '#' + c.toString( 16 ).padStart( 6, '0' );
		btn.addEventListener( 'pointerdown', ( e ) => {

			if ( session ) return;
			e.preventDefault();
			ensureAudio();
			stopDemo();
			selectColor( i );
			beginSession( { type: 'palette', kind: 'clay', colorIndex: i, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: false, pending: true } );

		} );
		palette.insertBefore( btn, eyeBtn );

	} );

	selectColor( 0 );

	for ( const [ id, kind ] of [ [ 'eyeBtn', 'eye' ], [ 'mouthBtn', 'mouth' ], [ 'hatBtn', 'hat' ] ] ) {

		document.getElementById( id ).addEventListener( 'pointerdown', ( e ) => {

			if ( session ) return;
			e.preventDefault();
			ensureAudio();
			stopDemo();
			beginSession( { type: 'palette', kind, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: false, pending: true } );

		} );

	}

	// 🤏 捏捏模式开关
	const kneadBtn = document.getElementById( 'kneadBtn' );
	hintEl = document.getElementById( 'hint' );
	defaultHint = hintEl.textContent;

	kneadBtn.addEventListener( 'pointerdown', ( e ) => {

		if ( session ) return;
		e.preventDefault();
		ensureAudio();
		stopDemo();
		kneading = ! kneading;
		kneadBtn.classList.toggle( 'selected', kneading );
		resetHint();

	} );

	// 🎬 看表演：游戏自己捏一个造型给你看
	document.getElementById( 'demoBtn' ).addEventListener( 'pointerdown', ( e ) => {

		if ( session ) return;
		e.preventDefault();
		ensureAudio();

		if ( demoRun ) { stopDemo(); return; }

		// 盘上有作品时，2.5 秒内再点一次才开演（开演会收走作品）
		if ( balls.length > 4 && performance.now() - demoArmedAt > 2600 ) {

			demoArmedAt = performance.now();
			setHint( '再点一下 🎬 开始表演（会收走现在的作品哦）' );
			setTimeout( () => { if ( ! demoRun ) resetHint(); }, 2600 );
			return;

		}

		startDemo();

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

function stopDemo() {

	if ( ! demoRun ) return;
	demoRun = null;
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
];

async function startDemo() {

	stopDemo();
	clearAll();

	const recipe = DEMO_RECIPES[ demoIndex % DEMO_RECIPES.length ];
	demoIndex ++;
	const token = { name: recipe.name };
	demoRun = token;

	// 中途被打断（用户碰画布/按钮）时 wait 会 reject，直接静默收场
	const S = {
		wait: ( ms ) => new Promise( ( resolve, reject ) => {

			setTimeout( () => ( demoRun === token ? resolve() : reject( new Error( 'demo-stopped' ) ) ), ms );

		} ),
		say: ( t ) => setHint( '🎬 ' + recipe.name + '：' + t ),
		clay: ( x, z, c ) => createClay( x, 3, z, c ),
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

function plop() {

	tone( 'sine', 420, 130, 0.12, 0.25 );

}

function boing() {

	tone( 'sine', 200, 520, 0.1, 0.18 );

}

function pop() {

	tone( 'triangle', 300, 900, 0.08, 0.15 );

}

function squish() {

	if ( ! actx ) return;
	const now = performance.now();
	if ( now - lastSquishAt < 80 ) return;
	lastSquishAt = now;

	if ( ! noiseBuffer ) {

		noiseBuffer = actx.createBuffer( 1, actx.sampleRate * 0.2, actx.sampleRate );
		const data = noiseBuffer.getChannelData( 0 );
		for ( let i = 0; i < data.length; i ++ ) data[ i ] = Math.random() * 2 - 1;

	}

	const t = actx.currentTime;
	const src = actx.createBufferSource();
	src.buffer = noiseBuffer;
	const filter = actx.createBiquadFilter();
	filter.type = 'lowpass';
	filter.frequency.setValueAtTime( 900, t );
	filter.frequency.exponentialRampToValueAtTime( 150, t + 0.18 );
	const g = actx.createGain();
	g.gain.setValueAtTime( 0.18, t );
	g.gain.exponentialRampToValueAtTime( 0.001, t + 0.18 );
	src.connect( filter ).connect( g ).connect( actx.destination );
	src.start( t );
	src.stop( t + 0.2 );

}

// ---------- 主循环 ----------

let acc = 0;
let lastT = performance.now();

function animate() {

	const now = performance.now();
	const dt = Math.min( ( now - lastT ) / 1000, 1 / 30 );
	lastT = now;
	acc += dt;

	while ( acc >= STEP ) {

		dragControl();
		b3.b3World_Step( world, STEP, 4 );
		stepCount ++;
		if ( stepCount % 6 === 0 ) stickyPass();
		if ( stepCount % 30 === 0 ) rescuePass();
		acc -= STEP;

	}

	syncEyes();
	rebuildClay();
	renderer.render( scene, camera );

}

// ---------- 调试钩子（也算控制台小彩蛋） ----------

window.__clay = {
	state: () => ( {
		balls: balls.map( ( r ) => {

			const p = b3.b3Body_GetPosition( r.body );
			return { id: r.id, kind: r.kind, form: r.form, dents: r.dents ? r.dents.length : 0, x: + p.x.toFixed( 2 ), y: + p.y.toFixed( 2 ), z: + p.z.toFixed( 2 ), awake: b3.b3Body_IsAwake( r.body ) };

		} ),
		joints: joints.length,
		sticky: stickyEnabled,
	} ),
	spawn: ( x, z, c ) => createClay( x, 3, z, c === undefined ? selected : c ),
	eye: ( x, z ) => createDecor( 'eye', x, 3, z ),
	decor: ( kind, x, z ) => createDecor( kind, x, 3, z ),
	morph: ( id ) => {

		const rec = balls.find( ( r ) => r.id === id );
		if ( rec ) setForm( rec, ( rec.form + 1 ) % FORMS.length );
		return rec ? rec.form : null;

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
	raw: () => ( { b3, world, effect, balls, FORMS } ),
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
			if ( stepCount % 30 === 0 ) rescuePass();

		}
		syncEyes();
		markDirty();
		rebuildClay();
		renderer.render( scene, camera );
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
