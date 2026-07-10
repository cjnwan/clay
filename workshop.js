// 工坊（手办搭建模式）：Stage 1 —— 身体模板 + 一次性高分辨率烘焙。
// 思路：metaball 只负责"浑然一体"的身体轮廓，且只在进工坊/换模板时烘焙一次
// （分辨率远高于实时场），烘完即弃 MC 实例——之后就是普通静态网格，零每帧成本。
// 耳朵/头套/色片等一切"清晰细节"都走网格部件，不进密度场。

import * as THREE from 'three';
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js';

// 与主场一致的场衰减系数（strengthFor 逻辑同源）
const SUBTRACT = 12;

// 身体模板：局部系配方，y 向上、原点在底部中心、+z 朝脸。
// 每球 { o:[x,y,z], r }，r 为期望视觉半径——Q 版比例的关键是头和身体差不多大
// 经验：脖子沟要可见，球心距 / 平均半径 ≈ 1.5（更近就融成蛋，更远会断开）
export const BODY_TEMPLATES = [
	{ name: '圆滚滚', balls: [
		{ o: [ 0, 0.5, 0 ], r: 0.68 },      // 圆身体
		{ o: [ 0, 1.5, 0.03 ], r: 0.56 },   // 大脑袋，微微前倾
	] },
	{ name: '高豆子', balls: [
		{ o: [ 0, 0.42, 0 ], r: 0.52 },
		{ o: [ 0, 1.14, 0 ], r: 0.44 },
		{ o: [ 0, 1.78, 0.03 ], r: 0.5 },
	] },
	{ name: '鼓肚子', balls: [
		{ o: [ 0, 0.55, 0 ], r: 0.62 },
		{ o: [ 0, 0.48, 0.3 ], r: 0.4 },   // 肚皮向前鼓（贴近本体，让它融进去）
		{ o: [ 0, 1.42, 0.03 ], r: 0.55 },
	] },
];

// 工坊摆在远离黏土板的世界角落：相机飞过去就是全屏转场，主板场景零改动
export const WORKSHOP_POS = new THREE.Vector3( 100, 0, 0 );

// 转盘台：两层木色圆盘 + 挂身体的图形组（rotation.y = 转盘角）
export function buildWorkshopStage( scene ) {

	const g = new THREE.Group();
	g.position.copy( WORKSHOP_POS );

	const base = new THREE.Mesh(
		new THREE.CylinderGeometry( 1.9, 2.15, 0.22, 48 ),
		new THREE.MeshStandardMaterial( { color: 0xd9b98a, roughness: 0.9 } ) );
	base.position.y = 0.11;
	const top = new THREE.Mesh(
		new THREE.CylinderGeometry( 1.42, 1.5, 0.16, 48 ),
		new THREE.MeshStandardMaterial( { color: 0xc9a06b, roughness: 0.85 } ) );
	top.position.y = 0.3;
	g.add( base, top );

	const figure = new THREE.Group();
	figure.position.y = 0.38;
	g.add( figure );

	scene.add( g );
	return { group: g, figure };

}

// ---------- 部件库：一切"清晰细节"都是真网格（硬边界、无分辨率下限） ----------
// paired = 自动左右镜像；sink = 底部嵌进身体的深度；role: 'body' 跟身体一起换色 / 'own' 用放置时选的颜色
// build(mat) 返回 +Z 朝外的网格
export const PARTS = {
	ear: { name: '耳朵', paired: true, sink: 0.07, role: 'body', build: ( mat ) => {

		const m = new THREE.Mesh( new THREE.SphereGeometry( 0.2, 20, 16 ), mat );
		m.scale.set( 1, 1, 0.55 ); // 略扁的圆耳朵
		return m;

	} },
	arm: { name: '小手', paired: true, sink: 0.1, role: 'body', build: ( mat ) => {

		const g = new THREE.CapsuleGeometry( 0.13, 0.22, 8, 16 );
		g.rotateX( Math.PI / 2 ); // 胶囊默认沿 Y，转成沿 +Z 伸出去
		g.translate( 0, 0, 0.1 );
		return new THREE.Mesh( g, mat );

	} },
	patch: { name: '色片', paired: false, sink: 0.03, role: 'own', centerSnap: true, build: ( mat ) => {

		const m = new THREE.Mesh( new THREE.SphereGeometry( 0.26, 24, 16 ), mat );
		m.scale.set( 1, 1, 0.2 ); // 压上去的一小片彩泥：扁球贴面，边界干净锐利
		return m;

	} },
	hood: { name: '头套', fitted: true, paired: false, sink: 0, role: 'own', build: null }, // 特殊：由 buildHoodPart 按当前身体生成
	eye: { name: '眼睛', paired: true, sink: 0.03, role: 'fixed', build: () => {

		const g = new THREE.Group();
		const white = new THREE.Mesh( new THREE.SphereGeometry( 0.1, 16, 12 ),
			new THREE.MeshStandardMaterial( { color: 0xffffff, roughness: 0.35 } ) );
		white.scale.set( 1, 1, 0.45 );
		const pupil = new THREE.Mesh( new THREE.SphereGeometry( 0.052, 12, 10 ),
			new THREE.MeshStandardMaterial( { color: 0x2f2620, roughness: 0.3 } ) );
		pupil.position.z = 0.045;
		g.add( white, pupil );
		return g;

	} },
	mouth: { name: '嘴巴', paired: false, sink: 0.005, role: 'fixed', centerSnap: true, build: () => {

		// 小小的 ω 嘴：细管沿弧线
		const curve = new THREE.CatmullRomCurve3( [
			new THREE.Vector3( - 0.085, 0.03, 0 ),
			new THREE.Vector3( - 0.04, - 0.035, 0.01 ),
			new THREE.Vector3( 0, 0.01, 0.012 ),
			new THREE.Vector3( 0.04, - 0.035, 0.01 ),
			new THREE.Vector3( 0.085, 0.03, 0 ),
		] );
		return new THREE.Mesh( new THREE.TubeGeometry( curve, 16, 0.02, 8 ),
			new THREE.MeshStandardMaterial( { color: 0x5a4030, roughness: 0.5 } ) );

	} },
	dot: { name: '圆点', paired: false, sink: 0.02, role: 'own', build: ( mat ) => {

		return new THREE.Mesh( new THREE.SphereGeometry( 0.055, 12, 10 ), mat );

	} },
};

// 造一个部件实例：独立材质（幽灵态要单独调透明度），黏土质感与本体一致
export function buildPart( partId, colorHex ) {

	const def = PARTS[ partId ];
	const mat = new THREE.MeshPhysicalMaterial( {
		color: colorHex,
		roughness: 0.58, clearcoat: 0.15, clearcoatRoughness: 0.5, envMapIntensity: 0.5,
	} );
	const group = new THREE.Group();
	const built = def.build( mat );
	group.add( built );
	const mats = [];
	group.traverse( ( o ) => {

		if ( o.isMesh ) {

			o.userData.isPart = true;
			if ( ! mats.includes( o.material ) ) mats.push( o.material );

		}

	} );
	return { group, mesh: built, mats };

}

// 头套：身体网格沿法线膨胀一圈 + 剪出脸部开口 + 底部收口 + 开口卷边。
// —— 截图里"玩偶服露脸"的关键：开口边界是网格边，硬边界无条件成立
export function buildHoodPart( bodyGeo, template, y0, colorHex ) {

	const OFF = 0.055;                                         // 布料厚度感
	const head = template.balls[ template.balls.length - 1 ];  // 约定：最后一球是头
	const hc = new THREE.Vector3( head.o[ 0 ], head.o[ 1 ] - y0, head.o[ 2 ] );
	const faceDir = new THREE.Vector3( 0, 0.1, 1 ).normalize();
	const fc = hc.clone().addScaledVector( faceDir, head.r );  // 脸开口球心（头表面上）
	const rOpen = head.r * 0.8;

	const pos = bodyGeo.getAttribute( 'position' );
	const nor = bodyGeo.getAttribute( 'normal' );
	const P = [], N = [];
	const va = new THREE.Vector3(), na = new THREE.Vector3(), cen = new THREE.Vector3();

	for ( let i = 0; i < pos.count; i += 3 ) {

		// 三角形质心（膨胀后）落在脸开口球内、或贴着地面 → 剪掉
		cen.set( 0, 0, 0 );
		for ( let j = 0; j < 3; j ++ ) {

			va.fromBufferAttribute( pos, i + j ).addScaledVector( na.fromBufferAttribute( nor, i + j ), OFF );
			cen.add( va );

		}
		cen.multiplyScalar( 1 / 3 );
		if ( cen.distanceTo( fc ) < rOpen || cen.y < 0.055 ) continue;
		for ( let j = 0; j < 3; j ++ ) {

			va.fromBufferAttribute( pos, i + j );
			na.fromBufferAttribute( nor, i + j );
			va.addScaledVector( na, OFF );
			P.push( va.x, va.y, va.z );
			N.push( na.x, na.y, na.z );

		}

	}

	const geo = new THREE.BufferGeometry();
	geo.setAttribute( 'position', new THREE.BufferAttribute( new Float32Array( P ), 3 ) );
	geo.setAttribute( 'normal', new THREE.BufferAttribute( new Float32Array( N ), 3 ) );

	const mat = new THREE.MeshPhysicalMaterial( {
		color: colorHex,
		roughness: 0.58, clearcoat: 0.15, clearcoatRoughness: 0.5, envMapIntensity: 0.5,
	} );
	const group = new THREE.Group();
	const shell = new THREE.Mesh( geo, mat );

	// 开口卷边：真黏土博主都会给开口滚一条边（也盖住裁剪毛边）
	const rim = new THREE.Mesh( new THREE.TorusGeometry( rOpen * 0.86, 0.068, 10, 40 ), mat );
	rim.position.copy( hc ).addScaledVector( faceDir, head.r + OFF - 0.045 );
	rim.quaternion.setFromUnitVectors( new THREE.Vector3( 0, 0, 1 ), faceDir );
	group.add( shell, rim );

	group.traverse( ( o ) => { if ( o.isMesh ) o.userData.isPart = true; } );
	return { group, mesh: shell, mats: [ mat ] };

}

// 把模板烘焙成静态 BufferGeometry 网格。
// 域取紧立方包围盒；域底比最低点略高一点，边界裁切自然给出"坐得平"的压扁底。
export function bakeBodyMesh( template, material, res = 88 ) {

	const t0 = performance.now();

	let minX = Infinity, minZ = Infinity, surfMinY = Infinity;
	let maxX = - Infinity, maxY = - Infinity, maxZ = - Infinity;
	for ( const b of template.balls ) {

		const m = b.r * 1.25; // metaball 影响余量
		minX = Math.min( minX, b.o[ 0 ] - m ); maxX = Math.max( maxX, b.o[ 0 ] + m );
		maxY = Math.max( maxY, b.o[ 1 ] + m );
		minZ = Math.min( minZ, b.o[ 2 ] - m ); maxZ = Math.max( maxZ, b.o[ 2 ] + m );
		surfMinY = Math.min( surfMinY, b.o[ 1 ] - b.r ); // 表面最低点（不是影响范围）

	}

	// 底面上收：域底切进表面一点，边界钳制（addBall 只写 cell≥1）给出平整封口的“坐得平”的底
	const FLATTEN = 0.07;
	const y0 = surfMinY + FLATTEN;
	const s = Math.max( maxX - minX, maxY - y0, maxZ - minZ ) / 2 + 0.02; // 域半尺寸（立方）
	const cx = ( minX + maxX ) / 2, cz = ( minZ + maxZ ) / 2;
	const cy = y0 + s;                // 域底恰在 y0

	const mc = new MarchingCubes( res, material, false, false, 200000 );

	for ( const b of template.balls ) {

		const rn = b.r / ( 2 * s );
		const strength = rn * rn * ( mc.isolation + SUBTRACT );
		mc.addBall(
			( b.o[ 0 ] - cx ) / ( 2 * s ) + 0.5,
			( b.o[ 1 ] - cy ) / ( 2 * s ) + 0.5,
			( b.o[ 2 ] - cz ) / ( 2 * s ) + 0.5,
			strength, SUBTRACT );

	}

	mc.update();

	// 只搬用到的那段顶点，MC 实例连同它的大缓冲一起丢给 GC
	const n = mc.count;
	const geo = new THREE.BufferGeometry();
	geo.setAttribute( 'position', new THREE.BufferAttribute( mc.geometry.getAttribute( 'position' ).array.slice( 0, n * 3 ), 3 ) );
	geo.setAttribute( 'normal', new THREE.BufferAttribute( mc.geometry.getAttribute( 'normal' ).array.slice( 0, n * 3 ), 3 ) );
	geo.scale( s, s, s );
	geo.translate( cx, cy - y0, cz ); // 压平的底落在局部 y≈0，摆上桌面即坐平
	mc.geometry.dispose();

	const mesh = new THREE.Mesh( geo, material );
	return { mesh, ms: performance.now() - t0, tris: n / 3, y0 };

}
