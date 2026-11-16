import { lazy, Suspense, useEffect, useState } from "react";
import {
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Box,
  ChevronRight,
  CircleHelp,
  Files,
  FileText,
  Gauge,
  Github,
  LayoutDashboard,
  Menu,
  Moon,
  Network,
  Route as RouteIcon,
  Settings2,
  SlidersHorizontal,
  Sun,
  Wifi,
  X,
} from "lucide-react";
import { useMihomo } from "./state/mihomo";
import { bytes } from "./lib/format";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { KernelSwitcher } from "./components/KernelSwitcher";
import { TrafficChart } from "./components/TrafficChart";
import { Toasts } from "./components/ui";
import { version as appVersion } from "../package.json";
import Home from "./pages/Home";

const Proxies = lazy(() => import("./pages/Proxies"));
const Providers = lazy(() => import("./pages/Providers"));
const Profiles = lazy(() => import("./pages/Profiles"));
const Connections = lazy(() => import("./pages/Connections"));
const Rules = lazy(() => import("./pages/Rules"));
const Logs = lazy(() => import("./pages/Logs"));
const Diagnostics = lazy(() => import("./pages/Diagnostics"));
const MihomoSettings = lazy(() => import("./pages/MihomoSettings"));
const Settings = lazy(() => import("./pages/Settings"));
const links = [
  { path: "/", label: "概览", icon: LayoutDashboard, section: "总览" },
  { path: "/proxies", label: "代理", icon: Wifi, section: "网络管理" },
  { path: "/providers", label: "资源", icon: Box },
  { path: "/profiles", label: "配置", icon: Files },
  { path: "/mihomo-settings", label: "内核设置", icon: SlidersHorizontal },
  { path: "/connections", label: "连接", icon: Network },
  { path: "/rules", label: "规则", icon: RouteIcon },
  { path: "/logs", label: "日志", icon: FileText },
  { path: "/diagnostics", label: "网络诊断", icon: Gauge },
  { path: "/settings", label: "设置", icon: Settings2, section: "偏好设置" },
];

function useTheme() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      let theme = "system";
      try {
        theme = localStorage.getItem("mihomo-verge.theme") ?? "system";
      } catch {
        /* Use system appearance if browser storage is unavailable. */
      }
      const value = theme === "dark" || (theme === "system" && media.matches);
      document.documentElement.dataset.theme = value ? "dark" : "light";
      setDark(value);
    };
    apply();
    media.addEventListener("change", apply);
    window.addEventListener("theme-change", apply);
    return () => {
      media.removeEventListener("change", apply);
      window.removeEventListener("theme-change", apply);
    };
  }, []);
  const toggle = () => {
    const value = !dark;
    try {
      localStorage.setItem("mihomo-verge.theme", value ? "dark" : "light");
    } catch {
      /* Theme still changes for this session. */
    }
    document.documentElement.dataset.theme = value ? "dark" : "light";
    setDark(value);
    window.dispatchEvent(new Event("theme-change"));
  };
  return { dark, toggle };
}

export function App() {
  const state = useMihomo();
  const [navOpen, setNavOpen] = useState(false);
  const { dark, toggle } = useTheme();
  const location = useLocation();
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);
  const page = links.find((link) => link.path === location.pathname);
  return (
    <div className="app-shell">
      {navOpen && (
        <button
          aria-label="关闭导航菜单"
          className="sidebar-scrim"
          onClick={() => setNavOpen(false)}
        />
      )}
      <aside className={`sidebar ${navOpen ? "open" : ""}`}>
        <KernelSwitcher />
        <nav className="navigation" aria-label="主导航">
          {links.map(({ path, label, icon: Icon, section }) => (
            <div key={path}>
              {section && <div className="nav-section">{section}</div>}
              <NavLink
                end={path === "/"}
                to={path}
                className={({ isActive }) =>
                  `nav-link ${isActive ? "active" : ""}`
                }
              >
                <Icon size={20} strokeWidth={1.8} />
                <span>{label}</span>
                {path === "/connections" && state.connected && (
                  <span className="nav-count">
                    {state.snapshot.connections.length}
                  </span>
                )}
              </NavLink>
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-traffic">
            <div className="sidebar-traffic-title">
              <Activity size={14} />
              实时流量
              <span
                className={state.live ? "status-dot" : "status-dot offline"}
              />
            </div>
            <TrafficChart data={state.history} mini />
            <div className="sidebar-rates">
              <span>
                <ArrowDown size={13} />
                <strong>{bytes(state.traffic.down)}</strong>
                <small>/s</small>
              </span>
              <span>
                <ArrowUp size={13} />
                <strong>{bytes(state.traffic.up)}</strong>
                <small>/s</small>
              </span>
            </div>
          </div>
          <div className="sidebar-footer">
            <span>WEB UI · v{appVersion}</span>
            <a
              href="https://github.com/imzlh/circud-plugin-mihomo"
              target="_blank"
              rel="noreferrer"
              aria-label="circud-plugin-mihomo GitHub"
            >
              <Github size={15} />
            </a>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button mobile-menu"
              aria-label="打开导航菜单"
              onClick={() => setNavOpen(!navOpen)}
            >
              {navOpen ? <X size={20} /> : <Menu size={20} />}
            </button>
            <span className="breadcrumb-brand">工作空间</span>
            <ChevronRight size={13} />
            <span>{page?.label ?? "概览"}</span>
          </div>
          <div className="topbar-actions">
            <span
              className={`connection-status ${state.connected ? "online" : ""}`}
            >
              <span
                className={`status-dot ${state.connected ? "" : "offline"}`}
              />
              {state.connected ? "内核已连接" : "等待连接"}
            </span>
            <span className="topbar-divider" />
            <a
              className="icon-button"
              href="https://wiki.metacubex.one/"
              target="_blank"
              rel="noreferrer"
              aria-label="Mihomo 使用文档"
            >
              <CircleHelp size={18} />
            </a>
            <button
              className="icon-button"
              onClick={toggle}
              aria-label={dark ? "切换浅色主题" : "切换深色主题"}
            >
              {dark ? <Sun size={18} /> : <Moon size={18} />}
            </button>
          </div>
        </header>
        <main className="main-content">
          {state.status === "error" && (
            <div className="error-note connection-error">
              <span>{state.error}</span>
              <button
                className="button small"
                onClick={() => void state.refresh()}
              >
                重试
              </button>
            </div>
          )}
          {state.connected && state.resourceError && (
            <div className="error-note">
              部分数据加载失败：{state.resourceError}
            </div>
          )}
          <ErrorBoundary>
            <Suspense
              fallback={
                <div className="page-loading">
                  <Gauge size={26} className="spin" />
                  正在加载…
                </div>
              }
            >
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/proxies" element={<Proxies />} />
                <Route path="/providers" element={<Providers />} />
                <Route path="/profiles" element={<Profiles />} />
                <Route path="/connections" element={<Connections />} />
                <Route path="/rules" element={<Rules />} />
                <Route path="/logs" element={<Logs />} />
                <Route path="/diagnostics" element={<Diagnostics />} />
                <Route path="/mihomo-settings" element={<MihomoSettings />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
      <Toasts items={state.toasts} dismiss={state.dismissToast} />
    </div>
  );
}
