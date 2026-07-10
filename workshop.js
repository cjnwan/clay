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
	return { mesh, ms: performance.now() - t0, tris: n / 3 };

}
