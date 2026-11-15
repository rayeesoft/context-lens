import AppKit
import Foundation
import SwiftUI

// MARK: - Data Models (Matches scripts/quota.mjs JSON)

struct QuotaSnapshot: Codable {
    let generatedAt: String
    let preferences: QuotaPreferences
    let syncStatus: SyncStatusInfo
    let statusBar: StatusBarSummary
    let pools: [String: PoolQuota]
    let poolOrder: [String]
    let activeSession: ActiveSessionInfo?
    let totals7d: Totals7dSummary
    let monthSummary: MonthSummary
    let credits: CreditsMemo
}

struct SyncStatusInfo: Codable {
    let state: String
    let lastErrorStatus: String?
    let label: String
    let syncedAt: String?
    let lastAttemptAt: String?
    let errorDetail: String?
    let proxyUrl: String?
}

struct QuotaPreferences: Codable {
    let planTier: String
    let planLabel: String
    let monthlyPriceUsd: Double
    let statusBarMode: String
    let primaryPool: String
}

struct StatusBarSummary: Codable {
    let poolKey: String
    let poolShortLabel: String
    let remainingPct: Int
    let remaining7dPct: Int
    let level: String
    let text: String
}

struct Pacing7dInfo: Codable {
    let status: String
    let dailyBurnUsd: Double
    let remainingBudgetUsd: Double
    let estRunwayDays: Double?
    let daysUntilReset: Double?
    let label: String
}

struct PoolQuota: Codable {
    let key: String
    let label: String
    let subtitle: String
    let shortLabel: String
    let remainingPct: Int
    let mode: String
    let win5hTurns: Int
    let win5hTokens: Int
    let win5hCostUsd: Double
    let win24hCostUsd: Double
    let win7dTurns: Int
    let win7dTokens: Int
    let win7dCostUsd: Double
    let configuredBudget5hUsd: Double
    let autoScalePeak: Bool
    let peak5hCost7dUsd: Double
    let effectiveBudget5hUsd: Double
    let countdownSeconds: Int?
    let countdownKind: String?
    let countdownLabel: String?
    let releaseCostUsd: Double
    let calibratedAt: String?
    let resetAt: String?
    let remaining7dPct: Int
    let mode7d: String
    let configuredBudget7dUsd: Double
    let autoScalePeak7d: Bool
    let peak7dCost14dUsd: Double
    let effectiveBudget7dUsd: Double
    let countdown7dSeconds: Int?
    let countdown7dKind: String?
    let countdown7dLabel: String?
    let reclaim24hCostUsd: Double
    let calibrated7dAt: String?
    let reset7dAt: String?
    let pacing7d: Pacing7dInfo
    let quotaAlert: QuotaAlertInfo?
}

struct QuotaAlertInfo: Codable {
    let tsMs: Double
    let poolKey: String
    let kind: String
    let message: String
}

struct ActiveSessionInfo: Codable {
    let conversationId: String
    let title: String
    let modelLabel: String
    let contextTokens: Int
    let cacheHitRate: Double
    let updatedAt: String
}

struct Totals7dSummary: Codable {
    let turns: Int
    let totalTokens: Int
    let costUsd: Double
}

struct MonthSummary: Codable {
    let month: String
    let turns: Int
    let totalTokens: Int
    let costUsd: Double
    let planPriceUsd: Double
    let roiMultiplier: Double?
}

struct CreditsMemo: Codable {
    let available: Double?
    let monthly: Double?
    let updatedAt: String?
}

// MARK: - Formatting Helpers

enum Formatters {
    static func tokens(_ n: Int) -> String {
        let val = Double(max(0, n))
        if val >= 1_000_000_000 {
            return String(format: "%.2fB", val / 1_000_000_000)
        }
        if val >= 1_000_000 {
            return String(format: "%.2fM", val / 1_000_000)
        }
        if val >= 1_000 {
            return String(format: "%.1fK", val / 1_000)
        }
        return "\(max(0, n))"
    }

    static func usd(_ v: Double, decimals: Int = 2) -> String {
        String(format: "$%.\(decimals)f", v)
    }

    static func number(_ v: Double) -> String {
        if v.rounded() == v {
            return String(Int(v))
        }
        return String(format: "%.1f", v)
    }

    static func levelColor(_ pct: Int, hasAlert: Bool = false) -> Color {
        if hasAlert || pct < 20 { return .red }
        if pct < 45 { return .orange }
        return .green
    }

    static func pacingColor(_ status: String) -> Color {
        switch status {
        case "critical": return .red
        case "tight": return .orange
        case "steady": return .blue
        case "ample": return .green
        default: return .secondary
        }
    }

    static func pacingIcon(_ status: String) -> String {
        switch status {
        case "critical": return "exclamationmark.triangle.fill"
        case "tight": return "exclamationmark.circle.fill"
        case "steady": return "clock.fill"
        case "ample": return "checkmark.circle.fill"
        default: return "sparkles"
        }
    }

    private static let isoWithFrac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let isoNoFrac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    static func parseIsoDate(_ str: String?) -> Date? {
        guard let str = str, !str.isEmpty else { return nil }
        return isoWithFrac.date(from: str) ?? isoNoFrac.date(from: str)
    }
}

// MARK: - Process Bridge

enum BridgeError: LocalizedError {
    case scriptNotFound(String)
    case executionFailed(String)
    case decodeFailed(String)

    var errorDescription: String? {
        switch self {
        case .scriptNotFound(let msg): return msg
        case .executionFailed(let msg): return msg
        case .decodeFailed(let msg): return msg
        }
    }
}

enum QuotaBridge {
    private static let homePath = FileManager.default.homeDirectoryForCurrentUser.path
    private static let nodeLock = NSLock()
    private static var cachedNodeOverride: String?
    private static var cachedNodeExec: (path: String, prefixArgs: [String])?

    private static func parseSemVer(_ dirName: String) -> (Int, Int, Int)? {
        let raw = dirName.hasPrefix("v") ? String(dirName.dropFirst()) : dirName
        let parts = raw.split(separator: ".").compactMap { Int($0) }
        guard parts.count >= 2 else { return nil }
        return (parts[0], parts[1], parts.count >= 3 ? parts[2] : 0)
    }

    private static func discoverNvmNodeCandidates() -> [String] {
        let versionsDir = "\(homePath)/.nvm/versions/node"
        guard let entries = try? FileManager.default.contentsOfDirectory(atPath: versionsDir) else {
            return []
        }
        let sorted = entries
            .compactMap { entry -> ((Int, Int, Int), String)? in
                guard let ver = parseSemVer(entry) else { return nil }
                return (ver, "\(versionsDir)/\(entry)/bin/node")
            }
            .sorted { a, b in a.0 > b.0 }
        return sorted.map { $0.1 }
    }

    static func resolveNodeExecutable() -> (path: String, prefixArgs: [String]) {
        let env = ProcessInfo.processInfo.environment
        let overrideBin = env["CL_NODE_BIN"] ?? ""

        nodeLock.lock()
        if let cached = cachedNodeExec, cachedNodeOverride == overrideBin {
            nodeLock.unlock()
            return cached
        }
        nodeLock.unlock()

        var candidates: [String] = []
        if !overrideBin.isEmpty {
            candidates.append(overrideBin)
        }
        candidates.append(contentsOf: [
            "/opt/homebrew/bin/node",
            "/opt/homebrew/opt/node/bin/node",
            "/opt/homebrew/opt/node@24/bin/node",
            "/opt/homebrew/opt/node@22/bin/node",
            "\(homePath)/.volta/bin/node",
            "\(homePath)/.local/share/mise/shims/node",
            "\(homePath)/.asdf/shims/node",
            "\(homePath)/.local/share/fnm/aliases/default/bin/node",
            "\(homePath)/Library/Application Support/fnm/aliases/default/bin/node",
        ])
        candidates.append(contentsOf: discoverNvmNodeCandidates())
        candidates.append("/usr/local/bin/node")

        var resolved: (path: String, prefixArgs: [String]) = ("/usr/bin/env", ["node"])
        for candidate in candidates {
            if !candidate.isEmpty && FileManager.default.isExecutableFile(atPath: candidate) {
                resolved = (candidate, [])
                break
            }
        }

        nodeLock.lock()
        cachedNodeOverride = overrideBin
        cachedNodeExec = resolved
        nodeLock.unlock()
        return resolved
    }

    static func resolveQuotaScript() -> String? {
        let env = ProcessInfo.processInfo.environment
        var candidates: [String] = []
        if let overridePath = env["CL_QUOTA_SCRIPT"], !overridePath.isEmpty {
            candidates.append(overridePath)
        }
        candidates.append("\(homePath)/.gemini/config/plugins/context-lens/scripts/quota.mjs")
        if let resUrl = Bundle.main.resourceURL {
            candidates.append(resUrl.appendingPathComponent("scripts/quota.mjs").path)
        }

        for path in candidates {
            if FileManager.default.isReadableFile(atPath: path) {
                return path
            }
        }
        return nil
    }

    static func resolveDashboardScript() -> String? {
        var candidates: [String] = [
            "\(homePath)/.gemini/config/plugins/context-lens/sidecars/dashboard/main.mjs"
        ]
        if let resUrl = Bundle.main.resourceURL {
            candidates.append(resUrl.appendingPathComponent("sidecars/dashboard/main.mjs").path)
        }
        for path in candidates {
            if FileManager.default.isReadableFile(atPath: path) {
                return path
            }
        }
        return nil
    }

    static func runQuotaCliSync(args: [String]) -> Result<QuotaSnapshot, BridgeError> {
        guard let scriptPath = resolveQuotaScript() else {
            return .failure(.scriptNotFound("未找到 Context Lens scripts/quota.mjs"))
        }

        let nodeInfo = resolveNodeExecutable()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: nodeInfo.path)
        process.arguments = nodeInfo.prefixArgs + [scriptPath] + args

        var env = ProcessInfo.processInfo.environment
        let existingPath = env["PATH"] ?? "/usr/bin:/bin"
        env["PATH"] = "\(homePath)/.local/bin:/opt/homebrew/bin:/usr/local/bin:\(existingPath)"
        process.environment = env

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe
        process.standardInput = FileHandle.nullDevice

        do {
            try process.run()
        } catch {
            return .failure(.executionFailed("无法启动 Node: \(error.localizedDescription)"))
        }

        // Read pipes completely before waitUntilExit to prevent buffer deadlocks.
        let outData = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
        let errData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()

        guard process.terminationStatus == 0 else {
            let errText = String(data: errData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if errText.contains("ERR_UNKNOWN_BUILTIN_MODULE") || errText.contains("node:sqlite") {
                return .failure(.executionFailed("检测到 Node.js 版本过低（需 >= 22.5 以支持内置 node:sqlite），请升级 Node（如 brew install node）后重试"))
            }
            if nodeInfo.path == "/usr/bin/env" && errText.contains("No such file or directory") {
                return .failure(.executionFailed("未找到 Node.js（需 >= 22.5），请安装 Node（如 brew install node）后重试"))
            }
            return .failure(.executionFailed(errText.isEmpty ? "quota.mjs exited \(process.terminationStatus)" : errText))
        }

        do {
            let decoder = JSONDecoder()
            let snapshot = try decoder.decode(QuotaSnapshot.self, from: outData)
            return .success(snapshot)
        } catch {
            return .failure(.decodeFailed("JSON 解析失败: \(error.localizedDescription)"))
        }
    }

    static func isLocalDashboardReachable(port: Int = 4799) -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/session") else { return false }
        let sem = DispatchSemaphore(value: 0)
        var reachable = false

        var req = URLRequest(url: url)
        req.timeoutInterval = 0.4
        let task = URLSession.shared.dataTask(with: req) { _, response, _ in
            if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                reachable = true
            }
            sem.signal()
        }
        task.resume()
        _ = sem.wait(timeout: .now() + 0.5)
        return reachable
    }

    static func launchStandaloneDashboard(port: Int = 4799) -> Bool {
        if isLocalDashboardReachable(port: port) {
            return true
        }
        guard let mainScript = resolveDashboardScript() else {
            return false
        }
        let nodeInfo = resolveNodeExecutable()
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: nodeInfo.path)
        proc.arguments = nodeInfo.prefixArgs + [mainScript, "--standalone", "--port", "\(port)"]

        var env = ProcessInfo.processInfo.environment
        let existingPath = env["PATH"] ?? "/usr/bin:/bin"
        env["PATH"] = "\(homePath)/.local/bin:/opt/homebrew/bin:/usr/local/bin:\(existingPath)"
        proc.environment = env
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        proc.standardInput = FileHandle.nullDevice

        do {
            try proc.run()
        } catch {
            return false
        }

        for _ in 0..<15 {
            Thread.sleep(forTimeInterval: 0.1)
            if isLocalDashboardReachable(port: port) {
                return true
            }
        }
        return false
    }
}

// MARK: - LaunchAgent Management

enum LaunchAgentHelper {
    static let label = "dev.contextlens.menubar"

    static var plistURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(label).plist")
    }

    static func isEnabled() -> Bool {
        FileManager.default.fileExists(atPath: plistURL.path)
    }

    static func setEnabled(_ enabled: Bool) throws {
        let fm = FileManager.default
        if !enabled {
            if fm.fileExists(atPath: plistURL.path) {
                try fm.removeItem(at: plistURL)
            }
            return
        }

        let execPath = Bundle.main.executablePath ?? ProcessInfo.processInfo.arguments[0]
        let dirURL = plistURL.deletingLastPathComponent()
        try fm.createDirectory(at: dirURL, withIntermediateDirectories: true)

        let dict: [String: Any] = [
            "Label": label,
            "ProgramArguments": [execPath],
            "RunAtLoad": true,
            "KeepAlive": false,
        ]
        let data = try PropertyListSerialization.data(fromPropertyList: dict, format: .xml, options: 0)
        try data.write(to: plistURL, options: .atomic)
    }
}

// MARK: - ViewModel

final class ContextLensViewModel: ObservableObject {
    @Published var snapshot: QuotaSnapshot?
    @Published var isLoading: Bool = false
    @Published var isSyncingCli: Bool = false
    @Published var errorMessage: String?
    @Published var lastUpdatedText: String = "—"
    @Published var launchAtLoginEnabled: Bool = LaunchAgentHelper.isEnabled()
    @Published var dashboardNotice: String?

    var onSnapshotUpdated: ((QuotaSnapshot) -> Void)?

    private let localQueue = DispatchQueue(label: "dev.contextlens.menubar.local", qos: .utility)
    private let cliSyncQueue = DispatchQueue(label: "dev.contextlens.menubar.clisync", qos: .utility)
    private let syncLock = NSLock()
    private var isCliSyncInFlight: Bool = false
    private let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f
    }()

    func refreshLocal() {
        runLocalCli(args: ["--json"])
    }

    func syncFromCloud() {
        syncLock.lock()
        if isCliSyncInFlight {
            syncLock.unlock()
            return
        }
        isCliSyncInFlight = true
        syncLock.unlock()

        DispatchQueue.main.async {
            self.isSyncingCli = true
        }
        cliSyncQueue.async {
            let result = QuotaBridge.runQuotaCliSync(args: ["--sync-cli"])
            DispatchQueue.main.async {
                self.syncLock.lock()
                self.isCliSyncInFlight = false
                self.syncLock.unlock()

                self.isSyncingCli = false
                self.applyCliResult(result)
            }
        }
    }

    func setProxyAndSync(_ proxyText: String) {
        let trimmed = proxyText.trimmingCharacters(in: .whitespacesAndNewlines)
        let arg = trimmed.isEmpty ? "clear" : trimmed
        DispatchQueue.main.async {
            self.isSyncingCli = true
        }
        cliSyncQueue.async {
            let result = QuotaBridge.runQuotaCliSync(args: ["--set-proxy", arg, "--sync-cli"])
            DispatchQueue.main.async {
                self.isSyncingCli = false
                self.applyCliResult(result)
            }
        }
    }

    func setPlan(_ tier: String) {
        runLocalCli(args: ["--set-plan", tier])
    }

    func setCredits(available: String, monthly: String) {
        var args = ["--set-credits"]
        let avTrim = available.trimmingCharacters(in: .whitespacesAndNewlines)
        let moTrim = monthly.trimmingCharacters(in: .whitespacesAndNewlines)
        args.append(contentsOf: ["--available", avTrim.isEmpty ? "clear" : avTrim])
        args.append(contentsOf: ["--monthly", moTrim.isEmpty ? "clear" : moTrim])
        runLocalCli(args: args)
    }

    func setDisplay(mode: String? = nil, pool: String? = nil) {
        var args = ["--set-display"]
        if let mode = mode {
            args.append(contentsOf: ["--mode", mode])
        }
        if let pool = pool {
            args.append(contentsOf: ["--pool", pool])
        }
        runLocalCli(args: args)
    }

    func toggleLaunchAtLogin() {
        let next = !launchAtLoginEnabled
        do {
            try LaunchAgentHelper.setEnabled(next)
            launchAtLoginEnabled = next
        } catch {
            errorMessage = "开机自启设置失败: \(error.localizedDescription)"
        }
    }

    func openWebDashboard() {
        dashboardNotice = "正在启动看板..."
        localQueue.async {
            let ok = QuotaBridge.launchStandaloneDashboard(port: 4799)
            DispatchQueue.main.async {
                if ok, let url = URL(string: "http://127.0.0.1:4799/") {
                    self.dashboardNotice = nil
                    NSWorkspace.shared.open(url)
                } else {
                    self.dashboardNotice = "未找到 sidecars/dashboard/main.mjs"
                }
            }
        }
    }

    private func runLocalCli(args: [String]) {
        DispatchQueue.main.async {
            self.isLoading = true
        }
        localQueue.async {
            let result = QuotaBridge.runQuotaCliSync(args: args)
            DispatchQueue.main.async {
                self.isLoading = false
                self.applyCliResult(result)
            }
        }
    }

    private func applyCliResult(_ result: Result<QuotaSnapshot, BridgeError>) {
        switch result {
        case .success(let snap):
            self.snapshot = snap
            self.errorMessage = nil
            self.lastUpdatedText = self.timeFormatter.string(from: Date())
            self.onSnapshotUpdated?(snap)
        case .failure(let err):
            self.errorMessage = err.localizedDescription
        }
    }
}

// MARK: - SwiftUI Popover Views

struct PopoverRootView: View {
    @ObservedObject var vm: ContextLensViewModel
    @State private var showCreditsEditor: Bool = false
    @State private var creditsAvailInput: String = ""
    @State private var creditsMonthlyInput: String = ""
    @State private var showProxyConfig: Bool = false
    @State private var proxyInput: String = ""

    private let planChoices: [(String, String)] = [
        ("ultra_20x", "Google AI Ultra"),
        ("ultra", "Google AI Ultra (Standard)"),
        ("pro", "Google AI Pro"),
        ("plus", "Google AI Plus"),
        ("free", "Free"),
    ]

    var body: some View {
        VStack(spacing: 0) {
            headerBar
            Divider()

            ScrollView(.vertical, showsIndicators: false) {
                VStack(spacing: 10) {
                    if let err = vm.errorMessage {
                        errorBanner(err)
                    }
                    if let notice = vm.dashboardNotice {
                        infoBanner(notice)
                    }

                    if let snap = vm.snapshot {
                        cloudSyncHelperBanners(snap)

                        if let session = snap.activeSession {
                            activeSessionCard(session)
                        }

                        ForEach(snap.poolOrder, id: \.self) { poolKey in
                            if let pool = snap.pools[poolKey] {
                                poolCard(pool)
                            }
                        }

                        summaryAndCreditsCard(snap)
                    } else if !vm.isLoading {
                        VStack(spacing: 8) {
                            Image(systemName: "chart.bar.xaxis")
                                .font(.title2)
                                .foregroundColor(.secondary)
                            Text("正在加载配额快照或暂无日志")
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 40)
                    }
                }
                .padding(12)
            }

            Divider()
            footerBar
        }
        .frame(width: 396, height: 535)
        .background(Color(NSColor.windowBackgroundColor))
    }

    private var headerBar: some View {
        HStack(spacing: 8) {
            HStack(spacing: 5) {
                Image(systemName: "bolt.fill")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(.accentColor)
                Text("Context Lens")
                    .font(.system(size: 13, weight: .semibold))
            }

            if let prefs = vm.snapshot?.preferences {
                Menu {
                    ForEach(planChoices, id: \.0) { tierKey, label in
                        Button {
                            vm.setPlan(tierKey)
                        } label: {
                            HStack {
                                Text(label)
                                if prefs.planTier == tierKey {
                                    Image(systemName: "checkmark")
                                }
                            }
                        }
                    }
                } label: {
                    Text(shortPlanBadge(prefs.planTier))
                        .font(.system(size: 10, weight: .medium))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(Color.accentColor.opacity(0.14))
                        .foregroundColor(.accentColor)
                        .clipShape(Capsule())
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
            }

            Spacer()

            if vm.isSyncingCli {
                HStack(spacing: 4) {
                    ProgressView()
                        .controlSize(.small)
                        .scaleEffect(0.7)
                    Text("云端同步中...")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundColor(.secondary)
                }
            } else if let sync = vm.snapshot?.syncStatus {
                Text(sync.label)
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundColor(syncLabelColor(sync))
                    .lineLimit(1)
            } else {
                Text(vm.lastUpdatedText)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(.secondary)
            }

            Button {
                vm.syncFromCloud()
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(vm.isSyncingCli ? .secondary : .primary)
            }
            .buttonStyle(.borderless)
            .disabled(vm.isSyncingCli)
            .help("通过 agy CLI 立即同步官方云端配额")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
    }

    private func syncLabelColor(_ sync: SyncStatusInfo) -> Color {
        if sync.lastErrorStatus != nil || (sync.state != "synced" && sync.state != "never_synced" && sync.state != "stale") {
            return .orange
        }
        if sync.state == "synced" {
            return .green
        }
        return .secondary
    }

    private func shortPlanBadge(_ tier: String) -> String {
        switch tier {
        case "ultra_20x": return "AI Ultra"
        case "ultra": return "Ultra Std"
        case "pro": return "AI Pro"
        case "plus": return "AI Plus"
        case "free": return "Free"
        default: return tier
        }
    }

    @ViewBuilder
    private func cloudSyncHelperBanners(_ snap: QuotaSnapshot) -> some View {
        let sync = snap.syncStatus
        let errStatus = sync.lastErrorStatus ?? (
            ["network_timeout", "proxy_error", "auth_required", "keyring_locked", "cli_missing"].contains(sync.state)
                ? sync.state
                : nil
        )
        let isNetworkErr = errStatus == "network_timeout" || errStatus == "proxy_error"
        let isAuthErr = errStatus == "auth_required" || errStatus == "keyring_locked" || errStatus == "cli_missing"

        if isAuthErr {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Image(systemName: "person.badge.key.fill")
                        .font(.system(size: 11))
                        .foregroundColor(.orange)
                    Text(sync.errorDetail ?? sync.label)
                        .font(.system(size: 10.5, weight: .medium))
                        .fixedSize(horizontal: false, vertical: true)
                }
                Text("完成后点击右上角 ↻ 同步官方配额")
                    .font(.system(size: 9.5))
                    .foregroundColor(.secondary)
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.orange.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }

        if showProxyConfig || isNetworkErr {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Image(systemName: "network")
                        .font(.system(size: 11))
                        .foregroundColor(.orange)
                    Text(sync.errorDetail ?? "可为 agy CLI 后台同步指定代理地址（系统代理已开启时可留空）：")
                        .font(.system(size: 10, weight: .medium))
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 4)
                    if showProxyConfig && !isNetworkErr {
                        Button("收起") {
                            withAnimation(.easeInOut(duration: 0.15)) {
                                showProxyConfig = false
                            }
                        }
                        .buttonStyle(.borderless)
                        .font(.system(size: 10))
                        .foregroundColor(.secondary)
                    }
                }

                HStack(spacing: 6) {
                    TextField("如 http://127.0.0.1:7890", text: $proxyInput)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: 10.5, design: .monospaced))
                    Button("保存并同步") {
                        vm.setProxyAndSync(proxyInput)
                    }
                    .controlSize(.small)
                    .disabled(vm.isSyncingCli)
                    if sync.proxyUrl != nil {
                        Button("清除") {
                            proxyInput = ""
                            vm.setProxyAndSync("clear")
                        }
                        .controlSize(.small)
                        .disabled(vm.isSyncingCli)
                    }
                }
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.orange.opacity(0.1))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .onAppear {
                if proxyInput.isEmpty, let existing = sync.proxyUrl {
                    proxyInput = existing
                }
            }
        }
    }

    private func activeSessionCard(_ session: ActiveSessionInfo) -> some View {
        let capTokens = 1_000_000.0
        let ratio = min(1.0, max(0.0, Double(session.contextTokens) / capTokens))
        let pct = Int((ratio * 100).rounded())
        let barColor: Color = pct >= 85 ? .red : (pct >= 70 ? .orange : .blue)

        return VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 6) {
                Text(session.title)
                    .font(.system(size: 12, weight: .semibold))
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 4)
                Text(session.modelLabel)
                    .font(.system(size: 10, weight: .medium))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.secondary.opacity(0.14))
                    .clipShape(Capsule())
                    .lineLimit(1)
            }

            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Color.secondary.opacity(0.18))
                        .frame(height: 5)
                    Capsule()
                        .fill(barColor)
                        .frame(width: max(4, geo.size.width * ratio), height: 5)
                }
            }
            .frame(height: 5)

            HStack {
                Text("上下文: \(Formatters.tokens(session.contextTokens)) / 1M (\(pct)%)")
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundColor(.secondary)
                Spacer()
                Text(String(format: "缓存命中 %.1f%%", session.cacheHitRate))
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundColor(.secondary)
            }
        }
        .padding(10)
        .background(cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color.primary.opacity(0.07), lineWidth: 1)
        )
    }

    private func poolCard(_ pool: PoolQuota) -> some View {
        let tint5h = Formatters.levelColor(pool.remainingPct, hasAlert: pool.quotaAlert != nil)
        let tint7d = Formatters.levelColor(pool.remaining7dPct, hasAlert: pool.quotaAlert != nil)
        let pacingTint = Formatters.pacingColor(pool.pacing7d.status)
        let badge = poolSourceBadge(pool)

        return VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 5) {
                        Text(pool.label)
                            .font(.system(size: 12, weight: .semibold))
                        Text(badge.text)
                            .font(.system(size: 9.5, weight: .medium))
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(badge.color.opacity(0.15))
                            .foregroundColor(badge.color)
                            .clipShape(Capsule())
                    }
                    Text(pool.subtitle)
                        .font(.system(size: 10))
                        .foregroundColor(.secondary)
                }

                Spacer()

                HStack(spacing: 4) {
                    Text("5h \(pool.remainingPct)%")
                        .foregroundColor(tint5h)
                    Text("·")
                        .foregroundColor(.secondary)
                    Text("7d \(pool.remaining7dPct)%")
                        .foregroundColor(tint7d)
                }
                .font(.system(size: 12.5, weight: .bold, design: .monospaced))
            }

            quotaMeterRow(
                title: "5h 限额",
                pct: pool.remainingPct,
                tint: tint5h,
                countdownLabel: pool.countdownLabel ?? "充裕",
                statsText: "\(pool.win5hTurns) 轮 · \(Formatters.tokens(pool.win5hTokens)) · \(Formatters.usd(pool.win5hCostUsd))"
            )

            quotaMeterRow(
                title: "7d 周限",
                pct: pool.remaining7dPct,
                tint: tint7d,
                countdownLabel: pool.countdown7dLabel ?? "充裕",
                statsText: "\(pool.win7dTurns) 轮 · \(Formatters.tokens(pool.win7dTokens)) · \(Formatters.usd(pool.win7dCostUsd))"
            )

            HStack(spacing: 4) {
                Image(systemName: Formatters.pacingIcon(pool.pacing7d.status))
                    .font(.system(size: 9.5))
                    .foregroundColor(pacingTint)
                Text(pool.pacing7d.label)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(pool.pacing7d.status == "idle" ? .secondary : pacingTint)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(pacingTint.opacity(pool.pacing7d.status == "idle" ? 0.08 : 0.12))
            .clipShape(RoundedRectangle(cornerRadius: 6))

            if let alert = pool.quotaAlert {
                HStack(spacing: 5) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 10))
                        .foregroundColor(.orange)
                    Text(alert.message)
                        .font(.system(size: 10))
                        .lineLimit(2)
                }
                .padding(6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.orange.opacity(0.12))
                .clipShape(RoundedRectangle(cornerRadius: 6))
            }
        }
        .padding(10)
        .background(cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color.primary.opacity(0.07), lineWidth: 1)
        )
    }

    private func poolSourceBadge(_ pool: PoolQuota) -> (text: String, color: Color) {
        switch pool.mode {
        case "cloud": return ("官方同步", .green)
        case "cloud_cached": return ("云端缓存", .blue)
        default: return ("本地估算", .secondary)
        }
    }

    private func quotaMeterRow(
        title: String,
        pct: Int,
        tint: Color,
        countdownLabel: String,
        statsText: String
    ) -> some View {
        let ratio = min(1.0, max(0.0, Double(pct) / 100.0))

        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(title)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(.secondary)
                    .frame(width: 42, alignment: .leading)

                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule()
                            .fill(Color.secondary.opacity(0.18))
                            .frame(height: 5.5)
                        Capsule()
                            .fill(tint)
                            .frame(width: max(pct > 0 ? 4 : 0, geo.size.width * ratio), height: 5.5)
                    }
                }
                .frame(height: 5.5)

                Text("\(pct)%")
                    .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                    .foregroundColor(tint)
                    .frame(width: 34, alignment: .trailing)

                Text(countdownLabel)
                    .font(.system(size: 9.5, design: .monospaced))
                    .foregroundColor(.secondary)
                    .frame(minWidth: 68, alignment: .trailing)
                    .lineLimit(1)
            }

            HStack {
                Spacer().frame(width: 48)
                Text(statsText)
                    .font(.system(size: 9.5, design: .monospaced))
                    .foregroundColor(.secondary)
                    .lineLimit(1)
            }
        }
    }

    private func summaryAndCreditsCard(_ snap: QuotaSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("近 7 天滚动累计")
                        .font(.system(size: 10))
                        .foregroundColor(.secondary)
                    Text(Formatters.usd(snap.totals7d.costUsd))
                        .font(.system(size: 14, weight: .bold, design: .monospaced))
                    Text("\(snap.totals7d.turns) 轮 · \(Formatters.tokens(snap.totals7d.totalTokens))")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundColor(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                Divider()
                    .frame(height: 36)

                VStack(alignment: .leading, spacing: 2) {
                    Text("本月 API 等值 (\(snap.monthSummary.month))")
                        .font(.system(size: 10))
                        .foregroundColor(.secondary)
                    Text(Formatters.usd(snap.monthSummary.costUsd))
                        .font(.system(size: 14, weight: .bold, design: .monospaced))
                    if let roi = snap.monthSummary.roiMultiplier {
                        Text("月费 \(Formatters.usd(snap.monthSummary.planPriceUsd)) · 约 \(String(format: "%.1fx", roi))")
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundColor(.green)
                    } else {
                        Text("Free 套餐 · \(Formatters.tokens(snap.monthSummary.totalTokens))")
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundColor(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            Divider()

            HStack(spacing: 6) {
                Text("AI Credits 备忘:")
                    .font(.system(size: 11, weight: .medium))
                Text(creditsSummaryText(snap.credits))
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(snap.credits.available == nil ? .secondary : .primary)
                Spacer()
                Button(showCreditsEditor ? "收起" : "设置") {
                    if !showCreditsEditor {
                        creditsAvailInput = snap.credits.available.map(Formatters.number) ?? ""
                        creditsMonthlyInput = snap.credits.monthly.map(Formatters.number) ?? ""
                    }
                    withAnimation(.easeInOut(duration: 0.15)) {
                        showCreditsEditor.toggle()
                    }
                }
                .buttonStyle(.borderless)
                .font(.system(size: 10.5))
                .foregroundColor(.accentColor)
            }

            if showCreditsEditor {
                HStack(spacing: 6) {
                    TextField("剩余", text: $creditsAvailInput)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: 11, design: .monospaced))
                    Text("/")
                        .foregroundColor(.secondary)
                    TextField("总额", text: $creditsMonthlyInput)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: 11, design: .monospaced))
                    Button("保存") {
                        vm.setCredits(available: creditsAvailInput, monthly: creditsMonthlyInput)
                        showCreditsEditor = false
                    }
                    .controlSize(.small)
                    Button("清空") {
                        creditsAvailInput = ""
                        creditsMonthlyInput = ""
                        vm.setCredits(available: "clear", monthly: "clear")
                        showCreditsEditor = false
                    }
                    .controlSize(.small)
                }
            }
        }
        .padding(10)
        .background(cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color.primary.opacity(0.07), lineWidth: 1)
        )
    }

    private func creditsSummaryText(_ credits: CreditsMemo) -> String {
        switch (credits.available, credits.monthly) {
        case (let av?, let mo?):
            return "剩余 \(Formatters.number(av)) / \(Formatters.number(mo))"
        case (let av?, nil):
            return "剩余 \(Formatters.number(av))"
        case (nil, let mo?):
            return "总额 \(Formatters.number(mo))"
        case (nil, nil):
            return "未设置"
        }
    }

    private var footerBar: some View {
        HStack(spacing: 8) {
            Button {
                vm.openWebDashboard()
            } label: {
                Label("打开网页看板", systemImage: "safari")
                    .font(.system(size: 11, weight: .medium))
            }
            .buttonStyle(.bordered)
            .controlSize(.small)

            Menu {
                Section("菜单栏显示格式") {
                    displayModeButton("dual_pct", label: "5h + 7d 双余量 (推荐)")
                    displayModeButton("pct7d_timer", label: "7d 周余量 + 倒计时")
                    displayModeButton("pct_timer", label: "5h 百分比 + 倒计时")
                    displayModeButton("pct_cost", label: "5h 百分比 + 金额")
                    displayModeButton("pct_only", label: "仅 5h 百分比")
                }
                Section("状态栏主追踪池") {
                    primaryPoolButton("auto", label: "自动跟随活跃池")
                    primaryPoolButton("gemini", label: "固定 Gemini Models")
                    primaryPoolButton("claude", label: "固定 Claude & GPT")
                }
                Divider()
                Button("网络代理设置...") {
                    proxyInput = vm.snapshot?.syncStatus.proxyUrl ?? ""
                    withAnimation(.easeInOut(duration: 0.15)) {
                        showProxyConfig.toggle()
                    }
                }
                Button {
                    vm.toggleLaunchAtLogin()
                } label: {
                    HStack {
                        Text("开机自动启动")
                        if vm.launchAtLoginEnabled {
                            Image(systemName: "checkmark")
                        }
                    }
                }
            } label: {
                Text("设置与自启")
                    .font(.system(size: 11, weight: .medium))
            }
            .menuStyle(.borderlessButton)
            .fixedSize()

            Spacer()

            Button("退出") {
                NSApp.terminate(nil)
            }
            .buttonStyle(.borderless)
            .font(.system(size: 11))
            .foregroundColor(.secondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private func displayModeButton(_ mode: String, label: String) -> some View {
        Button {
            vm.setDisplay(mode: mode, pool: nil)
        } label: {
            HStack {
                Text(label)
                if vm.snapshot?.preferences.statusBarMode == mode {
                    Image(systemName: "checkmark")
                }
            }
        }
    }

    private func primaryPoolButton(_ pool: String, label: String) -> some View {
        Button {
            vm.setDisplay(mode: nil, pool: pool)
        } label: {
            HStack {
                Text(label)
                if vm.snapshot?.preferences.primaryPool == pool {
                    Image(systemName: "checkmark")
                }
            }
        }
    }

    private func errorBanner(_ msg: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.circle.fill")
                .foregroundColor(.red)
            Text(msg)
                .font(.system(size: 10.5))
                .lineLimit(3)
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.red.opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func infoBanner(_ msg: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "info.circle.fill")
                .foregroundColor(.accentColor)
            Text(msg)
                .font(.system(size: 10.5))
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.accentColor.opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private var cardBackground: Color {
        Color(NSColor.controlBackgroundColor)
    }
}

// MARK: - AppDelegate & Status Item Controller

final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    private var statusItem: NSStatusItem!
    private var popover: NSPopover!
    private var localTimer: Timer?
    private var cloudSyncTimer: Timer?
    private var globalClickMonitor: Any?
    private let viewModel = ContextLensViewModel()

    func applicationDidFinishLaunching(_ notification: Notification) {
        terminateDuplicateInstances()

        NSApp.setActivationPolicy(.accessory)

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.target = self
            button.action = #selector(handleStatusBarClick(_:))
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
        updateStatusBarButton(snapshot: nil)

        let rootView = PopoverRootView(vm: viewModel)
        let hostingController = NSHostingController(rootView: rootView)
        popover = NSPopover()
        popover.contentSize = NSSize(width: 396, height: 535)
        popover.behavior = .transient
        popover.delegate = self
        popover.contentViewController = hostingController

        viewModel.onSnapshotUpdated = { [weak self] snap in
            self?.updateStatusBarButton(snapshot: snap)
        }

        viewModel.refreshLocal()
        viewModel.syncFromCloud()

        localTimer = Timer.scheduledTimer(withTimeInterval: 20.0, repeats: true) { [weak self] _ in
            self?.viewModel.refreshLocal()
        }
        cloudSyncTimer = Timer.scheduledTimer(withTimeInterval: 180.0, repeats: true) { [weak self] _ in
            self?.viewModel.syncFromCloud()
        }
    }

    private func terminateDuplicateInstances() {
        let myPid = ProcessInfo.processInfo.processIdentifier
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: "dev.contextlens.menubar")
        for app in running where app.processIdentifier != myPid {
            app.terminate()
        }
    }

    private func updateStatusBarButton(snapshot: QuotaSnapshot?) {
        guard let button = statusItem.button else { return }
        let level = snapshot?.statusBar.level ?? "ok"
        let symbolName = level == "critical" ? "exclamationmark.triangle.fill" : "bolt.fill"
        let text = snapshot?.statusBar.text ?? "--%"

        if let baseImage = NSImage(systemSymbolName: symbolName, accessibilityDescription: "Context Lens") {
            if level == "critical" {
                let cfg = NSImage.SymbolConfiguration(pointSize: 12, weight: .semibold)
                    .applying(NSImage.SymbolConfiguration(paletteColors: [.systemRed]))
                button.image = baseImage.withSymbolConfiguration(cfg)
            } else if level == "warn" {
                let cfg = NSImage.SymbolConfiguration(pointSize: 12, weight: .semibold)
                    .applying(NSImage.SymbolConfiguration(paletteColors: [.systemOrange]))
                button.image = baseImage.withSymbolConfiguration(cfg)
            } else {
                let cfg = NSImage.SymbolConfiguration(pointSize: 12, weight: .medium)
                let img = baseImage.withSymbolConfiguration(cfg)
                img?.isTemplate = true
                button.image = img
            }
        }

        button.imagePosition = .imageLeading
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium),
        ]
        button.attributedTitle = NSAttributedString(string: " \(text)", attributes: attrs)
    }

    @objc private func handleStatusBarClick(_ sender: NSStatusBarButton) {
        if let event = NSApp.currentEvent, event.type == .rightMouseUp {
            showContextMenu(anchor: sender)
            return
        }
        togglePopover(sender)
    }

    private func showContextMenu(anchor: NSStatusBarButton) {
        if popover.isShown {
            closePopover()
        }
        let menu = NSMenu()
        let refreshItem = NSMenuItem(title: "立即同步官方额度", action: #selector(menuRefresh), keyEquivalent: "r")
        refreshItem.target = self
        menu.addItem(refreshItem)

        let webItem = NSMenuItem(title: "打开完整网页看板", action: #selector(menuOpenDashboard), keyEquivalent: "")
        webItem.target = self
        menu.addItem(webItem)

        menu.addItem(.separator())

        let quitItem = NSMenuItem(title: "退出 ContextLensBar", action: #selector(menuQuit), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        statusItem.menu = menu
        anchor.performClick(nil)
        statusItem.menu = nil
    }

    @objc private func menuRefresh() {
        viewModel.syncFromCloud()
    }

    @objc private func menuOpenDashboard() {
        viewModel.openWebDashboard()
    }

    @objc private func menuQuit() {
        NSApp.terminate(nil)
    }

    private func togglePopover(_ button: NSStatusBarButton) {
        if popover.isShown {
            closePopover()
        } else {
            NSApp.activate(ignoringOtherApps: true)
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            installGlobalClickMonitor()
            viewModel.refreshLocal()

            let syncedDate = Formatters.parseIsoDate(viewModel.snapshot?.syncStatus.syncedAt)
            let isStaleForOpen = syncedDate == nil || Date().timeIntervalSince(syncedDate!) > 90.0
            if isStaleForOpen {
                viewModel.syncFromCloud()
            }
        }
    }

    private func closePopover() {
        popover.performClose(nil)
        removeGlobalClickMonitor()
    }

    private func installGlobalClickMonitor() {
        removeGlobalClickMonitor()
        globalClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            if let self = self, self.popover.isShown {
                self.closePopover()
            }
        }
    }

    private func removeGlobalClickMonitor() {
        if let monitor = globalClickMonitor {
            NSEvent.removeMonitor(monitor)
            globalClickMonitor = nil
        }
    }

    func popoverDidClose(_ notification: Notification) {
        removeGlobalClickMonitor()
    }
}

// MARK: - Program Entrypoint

if CommandLine.arguments.contains("--self-test") {
    switch QuotaBridge.runQuotaCliSync(args: ["--json"]) {
    case .success(let snap):
        let summary: [String: Any] = [
            "ok": true,
            "statusBarText": snap.statusBar.text,
            "planLabel": snap.preferences.planLabel,
            "poolsCount": snap.poolOrder.count,
            "syncState": snap.syncStatus.state,
        ]
        if let data = try? JSONSerialization.data(withJSONObject: summary, options: [.prettyPrinted]),
           let str = String(data: data, encoding: .utf8) {
            print(str)
        } else {
            print("{\"ok\":true}")
        }
        exit(0)
    case .failure(let err):
        fputs("{\"ok\":false,\"error\":\"\(err.localizedDescription)\"}\n", stderr)
        exit(1)
    }
} else {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.run()
}
