/**
 * 外观偏好持久化：背景图（整个应用界面）+ 接待员全局摆件设置（大小/固定/隐藏/
 * 随机觉醒）+ 多接待员名册（hosts：每位 = 名字/头像/专属语录/启用）。
 * 独立于规则 store（rules.json）：更新节奏与语义不同——外观是整体替换，
 * 无合并/墓碑；文件损坏按"无偏好"处理（外观退回默认，不阻断装载）。
 * 出厂默认 = 资产版（resolveDefaultAppearance：背景图+五位接待员头像走
 * assets/，台词库在 host-lines.ts，全局摆件偏好烘焙在 DEFAULT_APPEARANCE.host）。
 */
import type { Demeanor } from './narrative.js';
/** 外观配置形状；version 供未来结构迁移 */
export interface BackgroundConfig {
    enabled: boolean;
    /** 背景 图（data:image/*;base64 数据 URL；空串=未设置） */
    image: string;
    /** 背景透明度 0.05–1（调聊天区画布+侧栏+工具面板同一曲线；越高越透） */
    opacity: number;
    /** 聊天框透明度 0–1（1=气泡/输入卡不透明原样；只调聊天气泡与输入区） */
    chatOpacity: number;
}
/** 接待员全局摆件设置（形象本体在 hosts 名册里） */
export interface HostConfig {
    /** 悬浮球直径 px */
    size: number;
    /** 固定位置：锁定后不可拖拽（防误碰；右键菜单/接待员页可切换） */
    pinned: boolean;
    /** 隐藏接待员：悬浮球不再渲染，但提醒气泡照常弹出（接待员页可恢复） */
    hidden: boolean;
    /** 随机觉醒：true=每个会话从启用的接待员里随机一位（场次内稳定）；false=用 manualHostId */
    rotate: boolean;
    /** 手动指定的接待员 id（rotate=false 时生效；空串/失效时回落首位启用者） */
    manualHostId: string;
}
/** 常用语：按神态分组的台词库（空数组=该神态保持沉默） */
export type LinesConfig = {
    [K in Demeanor]: string[];
};
/** 一位接待员：迷宫中心的一位觉醒者（形象+专属剧本） */
export interface HostEntry {
    /** 稳定标识（启用/手动指定引用；保持不变便于外部引用） */
    id: string;
    /** 名字（悬浮球提示/接待员卡展示，如 Dolores、Maeve） */
    name: string;
    /** 头像：单个 emoji 字符或 data:image/* 数据 URL */
    avatar: string;
    /** 专属语录：该接待员自己的七神态台词库 */
    lines: LinesConfig;
    /** 启用：false=不参与觉醒（下台不删档） */
    enabled: boolean;
}
export interface AppearanceConfig {
    version: 1;
    background: BackgroundConfig;
    host: HostConfig;
    /** 接待员名册（第一位的 hosts[0] 是迁移来源；空名册=客户端回落内置默认形象） */
    hosts: HostEntry[];
    /** 上传过的头像存档池（跨接待员共享，最近的在前；方便换形象时直接取用） */
    avatars: string[];
}
/** 神态固定顺序（校验遍历与 UI 分组展示共用） */
export declare const DEMEANORS: readonly Demeanor[];
/** 迁移/默认时内建的第一位接待员（id 固定，供 manualHostId 引用） */
export declare const DEFAULT_HOST_ID = "dolores";
/**
 * 默认台词（Dolores）：接待员未提供某组台词时回落到她的库。
 * 五位接待员的完整出厂台词库在 host-lines.ts（逐字取自《西部世界》S1-S4，
 * Wikiquote 校对，由 live 配置烘焙生成，不要手改）。
 */
export declare const DEFAULT_LINES: LinesConfig;
/**
 * 纯内置默认（资产全缺失时的兜底）：五位出厂接待员（emoji 形象）+
 * 用户偏好烘焙的全局摆件设置（固定位置、指定 Dolores）。
 */
export declare const DEFAULT_APPEARANCE: AppearanceConfig;
/**
 * 资产版出厂默认：把插件 assets/ 里的默认背景/头像读成 data URL 装进默认配置
 * （背景一对资产，名册每位一资产；单资产缺失只影响该位回落 emoji，不 throw——
 * 默认值可降级，不是硬依赖）。读文件走同步（仅装载时调用一次）。
 * @param assetsDir 插件 assets 目录（通常 join(pluginRoot(), 'assets')）
 */
export declare function resolveDefaultAppearance(assetsDir: string): AppearanceConfig;
/**
 * 校验并归一外观配置（PUT 路由入口）。违反即 throw，错误信息带字段名。
 * UI 端会先做同款客户端校验，这里仍是权威边界（请求体来自 JSON 反序列化）。
 */
export declare function validateAppearance(raw: unknown): AppearanceConfig;
/**
 * 同步读取外观文件；不存在时才求值 fallback（可传工厂避免无谓读资产——
 * 用户文件存在时 resolveDefaultAppearance 完全不执行；缺省退纯内置默认）。
 * 结构损坏 throw（由调用方决定降级）。
 */
export declare function loadAppearanceSync(dataDir: string, fallback?: AppearanceConfig | (() => AppearanceConfig)): AppearanceConfig;
/** 原子写入（tmp + rename），避免半写文件在下次装载被当损坏 */
export declare function saveAppearanceSync(dataDir: string, cfg: AppearanceConfig): void;
