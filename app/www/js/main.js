(function () {
    "use strict";

    const treeApi = window.XinZipTree;
    const passwordStore = window.FnSmartZIPPasswordStore.createPasswordStore(
        window.localStorage,
    );
    const state = {
        filePath: "",
        info: null,
        entries: [],
        tree: [],
        allFilePaths: [],
        selectedPaths: new Set(),
        expandedPaths: new Set(),
        directoryRoots: [],
        directoryCache: new Map(),
        directoryExpanded: new Set(),
        selectedDirectory: "",
        pendingDirectory: "",
        pendingDirectorySelectable: false,
        directoryRequestId: 0,
        jobId: "",
        pollTimer: null,
        running: false,
        previewing: false,
        previewReady: false,
        previewLimited: false,
        passwordRequired: false,
        passwordVerified: true,
        permissionError: null,
        diagnosticsReport: null,
        lastRequestId: "",
        activeSavedPasswordId: "",
        selectedManagerPasswordId: "",
        editingPasswordId: "",
        returnToPasswordPrompt: false,
        passwordPresetOpen: false,
        previewRequestId: 0,
        searchRenderId: 0,
    };

    const $ = (id) => document.getElementById(id);
    const els = {
        archiveType: $("archiveType"),
        archiveTitle: $("archiveTitle"),
        cancelPasswordBtn: $("cancelPasswordBtn"),
        cancelPasswordRecordBtn: $("cancelPasswordRecordBtn"),
        cancelCreateDirectoryBtn: $("cancelCreateDirectoryBtn"),
        cancelDirectoryBtn: $("cancelDirectoryBtn"),
        cancelBtn: $("cancelBtn"),
        chooseDirectoryBtn: $("chooseDirectoryBtn"),
        closeDirectoryDialogBtn: $("closeDirectoryDialogBtn"),
        closeDiagnosticsDialogBtn: $("closeDiagnosticsDialogBtn"),
        closePasswordManagerDialogBtn: $("closePasswordManagerDialogBtn"),
        closePasswordPromptDialogBtn: $("closePasswordPromptDialogBtn"),
        closePasswordRecordDialogBtn: $("closePasswordRecordDialogBtn"),
        closePermissionDialogBtn: $("closePermissionDialogBtn"),
        closeResultDialogBtn: $("closeResultDialogBtn"),
        codePageSelect: $("codePageSelect"),
        confirmPasswordManagerBtn: $("confirmPasswordManagerBtn"),
        confirmPasswordRecordBtn: $("confirmPasswordRecordBtn"),
        confirmCreateDirectoryBtn: $("confirmCreateDirectoryBtn"),
        confirmResultDialogBtn: $("confirmResultDialogBtn"),
        copyDiagnosticsBtn: $("copyDiagnosticsBtn"),
        currentFile: $("currentFile"),
        createDirectoryBtn: $("createDirectoryBtn"),
        createDirectoryDialog: $("createDirectoryDialog"),
        createDirectoryError: $("createDirectoryError"),
        createDirectoryNameInput: $("createDirectoryNameInput"),
        deletePasswordBtn: $("deletePasswordBtn"),
        diagnosticsBtn: $("diagnosticsBtn"),
        diagnosticsContent: $("diagnosticsContent"),
        diagnosticsDialog: $("diagnosticsDialog"),
        directoryDialog: $("directoryDialog"),
        directoryDialogPath: $("directoryDialogPath"),
        directoryTree: $("directoryTree"),
        directoryUpBtn: $("directoryUpBtn"),
        downloadDiagnosticsBtn: $("downloadDiagnosticsBtn"),
        extractBtn: $("extractBtn"),
        fileCount: $("fileCount"),
        filePath: $("filePath"),
        fileTree: $("fileTree"),
        jobState: $("jobState"),
        notice: $("notice"),
        outputPreview: $("outputPreview"),
        openDirectoryPickerBtn: $("openDirectoryPickerBtn"),
        openPasswordManagerBtn: $("openPasswordManagerBtn"),
        openPasswordManagerFromPromptBtn: $("openPasswordManagerFromPromptBtn"),
        partCount: $("partCount"),
        passwordPromptDialog: $("passwordPromptDialog"),
        passwordPromptError: $("passwordPromptError"),
        passwordManagerDialog: $("passwordManagerDialog"),
        passwordManagerStatus: $("passwordManagerStatus"),
        passwordInput: $("passwordInput"),
        passwordPresetList: $("passwordPresetList"),
        passwordPresetToggleBtn: $("passwordPresetToggleBtn"),
        passwordRecordDialog: $("passwordRecordDialog"),
        passwordRecordDialogTitle: $("passwordRecordDialogTitle"),
        passwordRecordError: $("passwordRecordError"),
        passwordRecordList: $("passwordRecordList"),
        permissionDiagnosticsBtn: $("permissionDiagnosticsBtn"),
        permissionDialog: $("permissionDialog"),
        permissionDialogMessage: $("permissionDialogMessage"),
        progressFill: $("progressFill"),
        progressText: $("progressText"),
        refreshPreviewBtn: $("refreshPreviewBtn"),
        refreshDirectoryRootsBtn: $("refreshDirectoryRootsBtn"),
        recordLabelInput: $("recordLabelInput"),
        recordPasswordInput: $("recordPasswordInput"),
        retryPermissionBtn: $("retryPermissionBtn"),
        resultDialog: $("resultDialog"),
        resultOutputDir: $("resultOutputDir"),
        selectAllInput: $("selectAllInput"),
        selectedDirectoryPath: $("selectedDirectoryPath"),
        selectionSummary: $("selectionSummary"),
        showPasswordInput: $("showPasswordInput"),
        toolStatus: $("toolStatus"),
        totalSize: $("totalSize"),
        treeSearchInput: $("treeSearchInput"),
        volumeCount: $("volumeCount"),
        volumeList: $("volumeList"),
        verifyPasswordBtn: $("verifyPasswordBtn"),
        warningList: $("warningList"),
        addPasswordBtn: $("addPasswordBtn"),
        editPasswordBtn: $("editPasswordBtn"),
    };
    const searchScheduler = treeApi.createSearchScheduler({
        delay: 180,
    });

    function getQueryPath() {
        return new URLSearchParams(window.location.search).get("path") || "";
    }

    function getApiBaseUrl() {
        const apiUrl = new URL("api.cgi", window.location.href);
        const marker = "/index.cgi";
        const position = apiUrl.pathname.indexOf(marker);
        if (position >= 0) {
            apiUrl.pathname = `${apiUrl.pathname.slice(0, position)}/api.cgi`;
        }
        apiUrl.search = "";
        apiUrl.hash = "";
        return apiUrl;
    }

    function apiUrl(api, params) {
        const url = getApiBaseUrl();
        url.searchParams.set("api", api);
        Object.entries(params || {}).forEach(([key, value]) => {
            if (value !== undefined && value !== null && value !== "") {
                url.searchParams.set(key, value);
            }
        });
        return url.toString();
    }

    async function requestJson(url, options) {
        const response = await fetch(url, options);
        const contentType = response.headers.get("content-type") || "";
        const data = contentType.includes("application/json")
            ? await response.json()
            : { success: false, msg: await response.text() };
        if (!response.ok || !data.success) {
            const error = new Error(
                data.error?.message
                || data.msg
                || `请求失败：HTTP ${response.status}`,
            );
            error.code = data.error?.code || `HTTP_${response.status}`;
            error.requestId = data.requestId || "";
            error.details = data.error || null;
            throw error;
        }
        return data.data;
    }

    function postApi(api, body) {
        return requestJson(apiUrl(api), {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                api,
                ...body,
            }),
        });
    }

    function formatSize(size) {
        if (!Number.isFinite(Number(size))) {
            return "-";
        }
        const units = ["B", "KB", "MB", "GB", "TB"];
        let value = Number(size);
        let unit = 0;
        while (value >= 1024 && unit < units.length - 1) {
            value /= 1024;
            unit += 1;
        }
        const digits = value >= 10 || unit === 0 ? 0 : 1;
        return `${value.toFixed(digits)} ${units[unit]}`;
    }

    function setNotice(message, kind) {
        els.notice.className = `notice ${kind || ""}`.trim();
        els.notice.textContent = message;
    }

    function isPermissionError(error) {
        return error?.code === "SOURCE_FILE_DENIED"
            || error?.code === "SOURCE_PARENT_DENIED";
    }

    function openPermissionDialog(error) {
        state.permissionError = error || null;
        const deniedPath = error?.details?.path
            || error?.path
            || state.filePath;
        const fileName = String(deniedPath || "")
            .split("/")
            .filter(Boolean)
            .pop() || "当前文件";
        els.permissionDialogMessage.textContent = `当前文件未授予 FnSmartZIP 读取权限：“${fileName}”。请按以下步骤为上一级文件夹添加应用权限。`;
        els.permissionDialog.hidden = false;
    }

    function closePermissionDialog() {
        els.permissionDialog.hidden = true;
    }

    function handlePermissionError(error, requestId) {
        if (!isPermissionError(error)) {
            return false;
        }
        recordDiagnosticError(error, requestId);
        openPermissionDialog(error);
        return true;
    }

    function recordDiagnosticError(error, requestId) {
        state.lastRequestId = requestId || error?.requestId || "";
        state.diagnosticsReport = null;
        els.diagnosticsBtn.hidden = !state.filePath;
    }

    function clearDiagnosticError() {
        state.lastRequestId = "";
        state.diagnosticsReport = null;
        els.diagnosticsBtn.hidden = true;
    }

    function diagnosticsText() {
        return JSON.stringify(state.diagnosticsReport || {}, null, 2);
    }

    async function openDiagnostics() {
        if (!state.filePath) {
            return;
        }
        els.diagnosticsDialog.hidden = false;
        els.diagnosticsContent.textContent = "正在生成诊断报告...";
        try {
            state.diagnosticsReport = await requestJson(apiUrl("diagnostics", {
                path: state.filePath,
                requestId: state.lastRequestId,
            }));
            els.diagnosticsContent.textContent = diagnosticsText();
        } catch (error) {
            state.diagnosticsReport = {
                generatedAt: new Date().toISOString(),
                requestId: error.requestId || state.lastRequestId,
                error: {
                    code: error.code,
                    message: error.message,
                },
            };
            els.diagnosticsContent.textContent = diagnosticsText();
        }
    }

    function closeDiagnostics() {
        els.diagnosticsDialog.hidden = true;
    }

    function copyTextWithLegacyFallback(text) {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.append(textarea);
        textarea.select();
        const copied = document.execCommand("copy");
        textarea.remove();
        if (!copied) {
            throw new Error("浏览器不允许复制，请使用下载 JSON");
        }
    }

    async function copyDiagnostics() {
        const text = diagnosticsText();
        if (navigator.clipboard?.writeText) {
            try {
                await navigator.clipboard.writeText(text);
            } catch (error) {
                copyTextWithLegacyFallback(text);
            }
        } else {
            copyTextWithLegacyFallback(text);
        }
        els.copyDiagnosticsBtn.textContent = "已复制";
        window.setTimeout(() => {
            els.copyDiagnosticsBtn.textContent = "复制";
        }, 1500);
    }

    function downloadDiagnostics() {
        const blob = new Blob([diagnosticsText()], {
            type: "application/json;charset=utf-8",
        });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `FnSmartZIP-diagnostics-${Date.now()}.json`;
        anchor.click();
        URL.revokeObjectURL(url);
    }

    function setToolStatus(text, kind) {
        els.toolStatus.className = `status-badge ${kind || ""}`.trim();
        els.toolStatus.textContent = text;
    }

    function archiveTypeLabel(info) {
        const format = info?.selection?.format;
        if (format) {
            return format === "bzip2" ? "BZ2" : format.toUpperCase().slice(0, 5);
        }
        return info?.selection?.kind === "split" ? "SPLIT" : "ARC";
    }

    function pathWithin(root, candidate) {
        if (!root || !candidate) {
            return false;
        }
        const normalizedRoot = root.replace(/\/+$/, "");
        return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`);
    }

    function renderWarnings(warnings) {
        if (!warnings?.length) {
            els.warningList.hidden = true;
            els.warningList.textContent = "";
            return;
        }
        els.warningList.hidden = false;
        els.warningList.textContent = warnings.join("；");
    }

    function renderVolumes(parts) {
        els.volumeList.replaceChildren();
        els.volumeCount.textContent = String(parts?.length || 0);
        for (const part of parts || []) {
            const item = document.createElement("div");
            item.className = "volume-item";
            const name = document.createElement("span");
            name.textContent = part.name;
            name.title = part.path;
            const size = document.createElement("span");
            size.textContent = formatSize(part.size);
            item.append(name, size);
            els.volumeList.append(item);
        }
    }

    function renderInfo(info) {
        state.info = info;
        state.filePath = info.filePath;
        els.archiveType.textContent = archiveTypeLabel(info);
        els.archiveTitle.textContent = info.fileName;
        els.filePath.textContent = info.filePath;
        els.partCount.textContent = String(info.partCount || 1);
        renderWarnings(info.warnings);
        renderVolumes(info.parts);
        if (info.tool) {
            const sourceMap = {
                bundled: "内置 7-Zip 就绪",
                system: "系统 7-Zip 就绪",
                env: "指定 7-Zip 就绪",
            };
            setToolStatus(sourceMap[info.tool.source] || "7-Zip 就绪", "ok");
        } else {
            setToolStatus("缺少 7-Zip", "fail");
        }
        renderSavedPasswords(true);
        updateOutputPreview();
    }

    function currentArchiveKey() {
        return String(state.info?.fileName || "").toLocaleLowerCase();
    }

    function updatePasswordManagerStatus() {
        let status = "等待文件";
        if (state.info) {
            if (state.passwordRequired && !state.passwordVerified) {
                status = "待验证";
            } else if (state.passwordRequired && state.passwordVerified) {
                status = "密码已验证";
            } else {
                const count = passwordStore.list().length;
                status = count ? `已保存 ${count} 个密码` : "未保存密码";
            }
        }
        els.passwordManagerStatus.textContent = status;
    }

    function setPasswordPromptError(message) {
        els.passwordPromptError.textContent = message || "";
        els.passwordPromptError.hidden = !message;
    }

    function setPasswordRecordError(message) {
        els.passwordRecordError.textContent = message || "";
        els.passwordRecordError.hidden = !message;
    }

    function passwordPresetLabel(entry) {
        return entry.password;
    }

    function renderPasswordPresetList() {
        const entries = passwordStore.list();
        els.passwordPresetList.replaceChildren();
        if (!entries.length) {
            const empty = document.createElement("div");
            empty.className = "password-preset-empty";
            empty.textContent = "暂无已保存密码";
            els.passwordPresetList.append(empty);
            return;
        }
        for (const entry of entries) {
            const option = document.createElement("button");
            option.type = "button";
            option.className = "password-preset-option";
            option.textContent = passwordPresetLabel(entry);
            option.title = entry.label || entry.password;
            option.setAttribute("role", "option");
            option.addEventListener("click", () => selectPasswordPreset(entry.id));
            els.passwordPresetList.append(option);
        }
    }

    function renderPasswordManagerList() {
        const entries = passwordStore.list();
        if (
            state.selectedManagerPasswordId
            && !passwordStore.get(state.selectedManagerPasswordId)
        ) {
            state.selectedManagerPasswordId = "";
        }
        if (!state.selectedManagerPasswordId && entries.length) {
            state.selectedManagerPasswordId = state.activeSavedPasswordId
                && passwordStore.get(state.activeSavedPasswordId)
                ? state.activeSavedPasswordId
                : entries[0].id;
        }

        els.passwordRecordList.replaceChildren();
        if (!entries.length) {
            const empty = document.createElement("div");
            empty.className = "password-preset-empty";
            empty.textContent = "暂无已保存密码";
            els.passwordRecordList.append(empty);
        } else {
            for (const entry of entries) {
                const row = document.createElement("button");
                row.type = "button";
                row.className = "password-record-row";
                row.classList.toggle(
                    "is-selected",
                    entry.id === state.selectedManagerPasswordId,
                );
                row.setAttribute("role", "option");
                row.setAttribute(
                    "aria-selected",
                    entry.id === state.selectedManagerPasswordId ? "true" : "false",
                );
                const password = document.createElement("span");
                password.textContent = entry.password;
                const label = document.createElement("span");
                label.textContent = entry.label || "";
                row.append(password, label);
                row.addEventListener("click", () => selectManagerPassword(entry.id));
                els.passwordRecordList.append(row);
            }
        }
        const hasSelection = Boolean(state.selectedManagerPasswordId);
        els.editPasswordBtn.disabled = !hasSelection;
        els.deletePasswordBtn.disabled = !hasSelection;
    }

    function renderSavedPasswords() {
        const entries = passwordStore.list();
        if (
            state.activeSavedPasswordId
            && !passwordStore.get(state.activeSavedPasswordId)
        ) {
            state.activeSavedPasswordId = "";
        }
        if (!entries.length) {
            state.selectedManagerPasswordId = "";
        }
        renderPasswordPresetList();
        renderPasswordManagerList();
        updatePasswordManagerStatus();
    }

    function openPasswordPrompt(message) {
        renderSavedPasswords();
        setPasswordPromptError(message || "");
        closePasswordPresetList();
        els.passwordPromptDialog.hidden = false;
        window.setTimeout(() => els.passwordInput.focus(), 0);
    }

    function closePasswordPrompt(force = false) {
        if (state.previewing && !force) {
            return;
        }
        closePasswordPresetList();
        els.passwordPromptDialog.hidden = true;
        setPasswordPromptError("");
    }

    function togglePasswordPresetList() {
        state.passwordPresetOpen = !state.passwordPresetOpen;
        if (state.passwordPresetOpen) {
            renderPasswordPresetList();
        }
        els.passwordPresetList.hidden = !state.passwordPresetOpen;
        els.passwordPresetToggleBtn.setAttribute(
            "aria-expanded",
            state.passwordPresetOpen ? "true" : "false",
        );
    }

    function closePasswordPresetList() {
        state.passwordPresetOpen = false;
        els.passwordPresetList.hidden = true;
        els.passwordPresetToggleBtn.setAttribute("aria-expanded", "false");
    }

    function selectPasswordPreset(id) {
        const selected = passwordStore.get(id);
        if (!selected) {
            return;
        }
        state.activeSavedPasswordId = selected.id;
        els.passwordInput.value = selected.password;
        closePasswordPresetList();
        setPasswordPromptError("");
        invalidatePasswordVerification();
        updatePasswordManagerStatus();
    }

    function selectManagerPassword(id) {
        state.selectedManagerPasswordId = id;
        renderPasswordManagerList();
    }

    function openPasswordManager(source = "main") {
        state.returnToPasswordPrompt = source === "prompt"
            && !els.passwordPromptDialog.hidden;
        if (state.returnToPasswordPrompt) {
            els.passwordPromptDialog.hidden = true;
        }
        renderSavedPasswords();
        els.passwordManagerDialog.hidden = false;
    }

    function closePasswordManager() {
        els.passwordManagerDialog.hidden = true;
        if (state.returnToPasswordPrompt) {
            state.returnToPasswordPrompt = false;
            els.passwordPromptDialog.hidden = false;
            window.setTimeout(() => els.passwordInput.focus(), 0);
        }
    }

    function openPasswordRecordDialog(mode) {
        const editing = mode === "edit"
            ? passwordStore.get(state.selectedManagerPasswordId)
            : null;
        if (mode === "edit" && !editing) {
            return;
        }
        state.editingPasswordId = editing?.id || "";
        els.recordPasswordInput.value = editing?.password || "";
        els.recordLabelInput.value = editing?.label || "";
        els.passwordRecordDialogTitle.textContent = editing
            ? "编辑密码"
            : "添加密码";
        setPasswordRecordError("");
        els.passwordRecordDialog.hidden = false;
        window.setTimeout(() => els.recordPasswordInput.focus(), 0);
    }

    function closePasswordRecordDialog() {
        els.passwordRecordDialog.hidden = true;
        setPasswordRecordError("");
    }

    function invalidatePasswordVerification() {
        if (!state.passwordRequired) {
            return;
        }
        state.passwordVerified = false;
        updatePasswordManagerStatus();
        updateActionAvailability();
    }

    function rememberPasswordAfterSuccessfulPreview(previewRequest) {
        const password = previewRequest.password;
        if (!password) {
            return true;
        }

        const active = previewRequest.activeSavedPasswordId
            ? passwordStore.get(previewRequest.activeSavedPasswordId)
            : null;
        if (
            active
            && active.password === password
        ) {
            const touched = passwordStore.touch(active.id);
            renderSavedPasswords();
            return Boolean(touched);
        }
        return true;
    }

    function savePasswordRecord() {
        const password = els.recordPasswordInput.value;
        if (!password) {
            setPasswordRecordError("请输入需要保存的密码。");
            return;
        }
        const label = els.recordLabelInput.value.trim();
        const previous = state.editingPasswordId
            ? passwordStore.get(state.editingPasswordId)
            : null;
        const saved = passwordStore.save({
            id: state.editingPasswordId || undefined,
            label,
            password,
            archiveKey: "",
        });
        if (!saved) {
            setPasswordRecordError("浏览器无法保存密码，请检查本地存储权限。");
            return;
        }
        state.selectedManagerPasswordId = saved.id;
        if (previous?.id === state.activeSavedPasswordId) {
            state.activeSavedPasswordId = saved.id;
            els.passwordInput.value = saved.password;
            invalidatePasswordVerification();
        }
        closePasswordRecordDialog();
        renderSavedPasswords();
    }

    function deleteSelectedPassword() {
        const id = state.selectedManagerPasswordId;
        if (!id) {
            return;
        }
        passwordStore.remove(id);
        if (state.activeSavedPasswordId === id) {
            state.activeSavedPasswordId = "";
            els.passwordInput.value = "";
            invalidatePasswordVerification();
        }
        state.selectedManagerPasswordId = "";
        renderSavedPasswords();
    }

    function updateOutputPreview() {
        const directory = state.selectedDirectory;
        els.selectedDirectoryPath.textContent = directory || "-";
        els.selectedDirectoryPath.title = directory || "-";
        if (!directory || !state.info) {
            els.outputPreview.textContent = "-";
            return;
        }
        const separator = directory.endsWith("/") ? "" : "/";
        els.outputPreview.textContent = `${directory}${separator}${state.info.outputStem}`;
    }

    function renderTree() {
        const renderId = ++state.searchRenderId;
        els.fileTree.replaceChildren();
        if (!state.previewReady && !state.previewLimited) {
            const empty = document.createElement("div");
            empty.className = "tree-empty";
            empty.textContent = "尚未载入压缩包目录";
            els.fileTree.append(empty);
            updateSelectionSummary();
            return;
        }
        if (state.previewLimited) {
            const empty = document.createElement("div");
            empty.className = "tree-empty";
            empty.textContent = "压缩包内容超过预览限制，将按整包方式解压。";
            els.fileTree.append(empty);
            updateSelectionSummary();
            return;
        }

        const query = els.treeSearchInput?.value.trim() || "";
        if (query) {
            renderSearchResults(query, renderId);
            updateSelectionSummary();
            return;
        }

        const fragment = document.createDocumentFragment();
        for (const node of state.tree) {
            appendTreeNode(fragment, node, 0);
        }
        els.fileTree.append(fragment);
        updateSelectionSummary();
    }

    function renderSearchResults(query, renderId) {
        const matches = treeApi.searchFiles(state.entries, query);
        if (!matches.length) {
            const empty = document.createElement("div");
            empty.className = "tree-empty";
            empty.textContent = "没有匹配的文件";
            els.fileTree.append(empty);
            return;
        }

        treeApi.renderBatches(matches, {
            batchSize: 200,
            scheduleFrame(callback) {
                if (window.requestAnimationFrame) {
                    window.requestAnimationFrame(callback);
                } else {
                    window.setTimeout(callback, 0);
                }
            },
            isCurrent() {
                return (
                    renderId === state.searchRenderId
                    && query === (els.treeSearchInput?.value.trim() || "")
                );
            },
            renderBatch(entries) {
                const fragment = document.createDocumentFragment();
                for (const entry of entries) {
                    appendSearchFileRow(fragment, entry);
                }
                els.fileTree.append(fragment);
            },
        });
    }

    function appendSearchFileRow(container, entry) {
        const row = document.createElement("div");
        row.className = "tree-row tree-search-row";
        row.style.setProperty("--tree-depth", "0");
        row.title = entry.path;

        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "tree-toggle is-placeholder";
        toggle.tabIndex = -1;

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "tree-checkbox";
        checkbox.checked = state.selectedPaths.has(entry.path);
        checkbox.setAttribute("aria-label", `选择 ${entry.path}`);
        checkbox.addEventListener("change", () => {
            if (checkbox.checked) {
                state.selectedPaths.add(entry.path);
            } else {
                state.selectedPaths.delete(entry.path);
            }
            updateSelectionSummary();
        });

        const icon = document.createElement("span");
        icon.className = "tree-icon file";
        icon.setAttribute("aria-hidden", "true");

        const label = document.createElement("span");
        label.className = "tree-label";
        const normalizedPath = String(entry.path || "").replace(/\\/g, "/");
        label.textContent = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);

        const size = document.createElement("span");
        size.className = "tree-size";
        size.textContent = formatSize(entry.size);

        row.append(toggle, checkbox, icon, label, size);
        container.append(row);
    }

    function appendTreeNode(container, node, depth) {
        const row = document.createElement("div");
        row.className = "tree-row";
        row.style.setProperty("--tree-depth", String(depth));
        row.title = node.path;

        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "tree-toggle";
        const hasChildren = node.type === "directory" && node.children?.length;
        if (!hasChildren) {
            toggle.classList.add("is-placeholder");
        } else {
            toggle.textContent = "›";
            toggle.classList.toggle("is-open", state.expandedPaths.has(node.path));
            toggle.setAttribute("aria-label", state.expandedPaths.has(node.path) ? "折叠目录" : "展开目录");
            toggle.addEventListener("click", () => {
                if (state.expandedPaths.has(node.path)) {
                    state.expandedPaths.delete(node.path);
                } else {
                    state.expandedPaths.add(node.path);
                }
                renderTree();
            });
        }

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "tree-checkbox";
        const nodeState = treeApi.selectionState(node, state.selectedPaths);
        checkbox.checked = nodeState === "checked";
        checkbox.indeterminate = nodeState === "mixed";
        checkbox.setAttribute("aria-label", `选择 ${node.path}`);
        checkbox.addEventListener("change", () => {
            const paths = treeApi.collectDescendantFiles(node);
            for (const filePath of paths) {
                if (checkbox.checked) {
                    state.selectedPaths.add(filePath);
                } else {
                    state.selectedPaths.delete(filePath);
                }
            }
            renderTree();
        });

        const icon = document.createElement("span");
        icon.className = `tree-icon ${node.type === "directory" ? "folder" : "file"}`;
        icon.setAttribute("aria-hidden", "true");

        const label = document.createElement("span");
        label.className = "tree-label";
        label.textContent = node.name;

        const size = document.createElement("span");
        size.className = "tree-size";
        size.textContent = node.type === "file" ? formatSize(node.size) : "";

        row.append(toggle, checkbox, icon, label, size);
        container.append(row);

        if (hasChildren && state.expandedPaths.has(node.path)) {
            for (const child of node.children) {
                appendTreeNode(container, child, depth + 1);
            }
        }
    }

    function updateSelectionSummary() {
        const selectedCount = state.previewLimited
            ? state.allFilePaths.length
            : state.selectedPaths.size;
        if (state.previewLimited) {
            els.selectionSummary.textContent = "预览受限，将解压全部文件";
        } else if (!state.previewReady) {
            els.selectionSummary.textContent = "等待预览";
        } else {
            els.selectionSummary.textContent = `已选择 ${selectedCount} / ${state.allFilePaths.length} 个文件`;
        }

        const allSelected = state.allFilePaths.length > 0
            && state.selectedPaths.size === state.allFilePaths.length;
        els.selectAllInput.checked = allSelected;
        els.selectAllInput.indeterminate = state.selectedPaths.size > 0 && !allSelected;
        updateActionAvailability();
    }

    function setPreviewControls(enabled) {
        els.selectAllInput.disabled = !enabled;
        if (els.treeSearchInput) {
            els.treeSearchInput.disabled = !enabled;
        }
    }

    async function loadPreview(options = {}) {
        if (!state.filePath || state.running) {
            return false;
        }
        searchScheduler.cancel();
        state.searchRenderId += 1;
        const preserveExisting = Boolean(
            options.fromPasswordManager
            && state.entries.length
            && state.previewReady,
        );
        const previousPreview = preserveExisting ? {
            entries: state.entries,
            tree: state.tree,
            allFilePaths: state.allFilePaths,
            selectedPaths: new Set(state.selectedPaths),
            expandedPaths: new Set(state.expandedPaths),
        } : null;
        state.previewing = true;
        if (!preserveExisting) {
            state.previewReady = false;
            state.previewLimited = false;
            state.passwordRequired = false;
            state.passwordVerified = true;
            els.fileTree.innerHTML = '<div class="tree-empty">正在生成文件树...</div>';
        }
        setPreviewControls(false);
        setNotice("正在读取压缩包目录...");
        const previewRequest = {
            id: ++state.previewRequestId,
            password: els.passwordInput.value,
            codePage: els.codePageSelect.value,
            activeSavedPasswordId: state.activeSavedPasswordId,
        };
        let succeeded = false;
        try {
            const preview = await postApi("preview", {
                path: state.filePath,
                password: previewRequest.password,
                codePage: previewRequest.codePage,
            });
            if (previewRequest.id !== state.previewRequestId) {
                return false;
            }
            state.entries = preview.entries || [];
            state.tree = treeApi.buildTree(state.entries);
            state.allFilePaths = state.entries
                .filter((entry) => entry.type === "file")
                .map((entry) => entry.path);
            state.selectedPaths = new Set(state.allFilePaths);
            state.expandedPaths = new Set(
                state.tree
                    .filter((node) => node.type === "directory")
                    .map((node) => node.path),
            );
            state.previewReady = true;
            state.passwordRequired = Boolean(preview.passwordRequired);
            state.passwordVerified = preview.passwordVerified !== false;
            els.fileCount.textContent = String(preview.summary?.fileCount || 0);
            els.totalSize.textContent = formatSize(preview.summary?.totalSize || 0);
            setPreviewControls(true);
            clearDiagnosticError();
            if (state.passwordRequired && !state.passwordVerified) {
                setNotice(
                    "检测到加密文件，请在密码管理器中验证后继续。",
                    "error",
                );
                openPasswordPrompt("检测到加密文件，请输入或选择密码后验证。");
            } else {
                const passwordStored = rememberPasswordAfterSuccessfulPreview(previewRequest);
                setNotice(
                    passwordStored
                        ? (
                            preview.summary?.encrypted
                                ? "密码验证成功，可以选择文件并开始解压。"
                                : "预览完成，可以选择文件并开始解压。"
                        )
                        : "预览完成，但密码未能写入浏览器本地存储。",
                    "success",
                );
                succeeded = true;
                if (options.fromPasswordManager) {
                    closePasswordPrompt(true);
                }
            }
        } catch (error) {
            if (previewRequest.id !== state.previewRequestId) {
                return false;
            }
            if (
                previousPreview
                && (error.code === "PASSWORD" || error.code === "PASSWORD_REQUIRED")
            ) {
                state.entries = previousPreview.entries;
                state.tree = previousPreview.tree;
                state.allFilePaths = previousPreview.allFilePaths;
                state.selectedPaths = previousPreview.selectedPaths;
                state.expandedPaths = previousPreview.expandedPaths;
                state.previewReady = true;
            } else {
                state.entries = [];
                state.tree = [];
                state.allFilePaths = [];
                state.selectedPaths.clear();
            }
            if (error.code === "PREVIEW_LIMIT") {
                state.previewLimited = true;
                setNotice("压缩包内容超过预览限制，仍可整包解压。");
            } else if (error.code === "PREVIEW_INTERRUPTED") {
                state.previewLimited = true;
                setNotice("预览被系统中断，可整包解压。", "error");
                recordDiagnosticError(error);
            } else if (error.code === "PASSWORD_REQUIRED") {
                state.passwordRequired = true;
                state.passwordVerified = false;
                setNotice("压缩包文件头已加密，请在密码管理器中验证。", "error");
                recordDiagnosticError(error);
                openPasswordPrompt("文件头已加密，请输入密码后验证并预览。");
            } else if (error.code === "PASSWORD") {
                state.passwordRequired = true;
                state.passwordVerified = false;
                setNotice("密码错误，请重新输入后验证。", "error");
                recordDiagnosticError(error);
                openPasswordPrompt("密码错误，请检查后重新验证。");
            } else if (handlePermissionError(error)) {
                setNotice(error.message, "error");
            } else {
                setNotice(error.message, "error");
                recordDiagnosticError(error);
            }
        } finally {
            state.previewing = false;
            renderTree();
            updatePasswordManagerStatus();
            updateActionAvailability();
        }
        return succeeded;
    }

    async function verifyPasswordAndPreview() {
        if (!els.passwordInput.value) {
            setPasswordPromptError("请输入解压密码。");
            els.passwordInput.focus();
            return;
        }
        setPasswordPromptError("");
        els.verifyPasswordBtn.disabled = true;
        els.verifyPasswordBtn.textContent = "正在验证...";
        try {
            await loadPreview({ fromPasswordManager: true });
        } finally {
            els.verifyPasswordBtn.textContent = "确定";
            updateActionAvailability();
        }
    }

    function directoryRootPath(root) {
        return typeof root === "string" ? root : root.path;
    }

    function currentBrowsingRoot() {
        return state.directoryRoots
            .filter((root) => pathWithin(directoryRootPath(root), state.pendingDirectory))
            .sort((a, b) => directoryRootPath(b).length - directoryRootPath(a).length)[0]
            || null;
    }

    function selectDirectoryNode(node) {
        state.pendingDirectory = node.path;
        state.pendingDirectorySelectable = Boolean(node.canSelect);
        els.directoryDialogPath.textContent = node.path;
        els.directoryDialogPath.title = node.path;
        els.chooseDirectoryBtn.disabled = !node.canSelect;
        els.createDirectoryBtn.disabled = !node.canSelect;
        const root = currentBrowsingRoot();
        els.directoryUpBtn.disabled = !root
            || state.pendingDirectory === directoryRootPath(root);
        renderDirectoryTree();
    }

    function appendDirectoryNode(container, node, depth) {
        const row = document.createElement("div");
        row.className = "directory-node-row";
        row.style.setProperty("--directory-depth", depth);
        row.setAttribute("role", "treeitem");
        row.setAttribute("aria-selected", String(node.path === state.pendingDirectory));
        if (node.path === state.pendingDirectory) {
            row.classList.add("is-selected");
        }

        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "directory-node-toggle";
        toggle.textContent = "›";
        toggle.title = "展开目录";
        toggle.disabled = !node.canBrowse;
        if (state.directoryExpanded.has(node.path)) {
            toggle.classList.add("is-open");
        }
        toggle.addEventListener("click", async (event) => {
            event.stopPropagation();
            if (state.directoryExpanded.has(node.path)) {
                state.directoryExpanded.delete(node.path);
                renderDirectoryTree();
                return;
            }
            state.directoryExpanded.add(node.path);
            renderDirectoryTree();
            await loadDirectoryChildren(node.path);
        });

        const label = document.createElement("button");
        label.type = "button";
        label.className = "directory-node-label";
        label.textContent = depth === 0 ? node.path : (node.name || node.path);
        label.title = node.path;
        label.addEventListener("click", () => selectDirectoryNode(node));

        const status = document.createElement("small");
        status.textContent = node.canSelect ? "可选择" : "只读";
        row.append(toggle, label, status);
        container.append(row);

        if (!state.directoryExpanded.has(node.path)) {
            return;
        }
        const listing = state.directoryCache.get(node.path);
        if (!listing) {
            const loading = document.createElement("div");
            loading.className = "directory-tree-state";
            loading.style.setProperty("--directory-depth", depth + 1);
            loading.textContent = "正在加载...";
            container.append(loading);
            return;
        }
        if (!listing.children.length) {
            const empty = document.createElement("div");
            empty.className = "directory-tree-state";
            empty.style.setProperty("--directory-depth", depth + 1);
            empty.textContent = "没有子目录";
            container.append(empty);
            return;
        }
        for (const child of listing.children) {
            appendDirectoryNode(container, child, depth + 1);
        }
    }

    function renderDirectoryTree() {
        els.directoryTree.replaceChildren();
        if (!state.directoryRoots.length) {
            const empty = document.createElement("div");
            empty.className = "tree-empty";
            empty.textContent = "没有可访问的授权目录";
            els.directoryTree.append(empty);
            return;
        }
        for (const root of state.directoryRoots) {
            appendDirectoryNode(els.directoryTree, {
                name: directoryRootPath(root),
                path: directoryRootPath(root),
                canBrowse: root.canBrowse ?? true,
                canSelect: root.canSelect ?? true,
            }, 0);
        }
    }

    async function loadDirectoryChildren(directoryPath, force = false) {
        if (!force && state.directoryCache.has(directoryPath)) {
            return state.directoryCache.get(directoryPath);
        }
        const requestId = state.directoryRequestId;
        try {
            const result = await requestJson(apiUrl("directories", {
                archivePath: state.filePath,
                path: directoryPath,
            }));
            if (requestId !== state.directoryRequestId || els.directoryDialog.hidden) {
                return null;
            }
            state.directoryCache.set(directoryPath, result);
            renderDirectoryTree();
            return result;
        } catch (error) {
            if (requestId === state.directoryRequestId) {
                state.directoryExpanded.delete(directoryPath);
                renderDirectoryTree();
                setNotice(error.message, "error");
                recordDiagnosticError(error);
            }
            return null;
        }
    }

    async function revealDirectoryPath(directoryPath) {
        const root = state.directoryRoots
            .filter((entry) => pathWithin(directoryRootPath(entry), directoryPath))
            .sort((a, b) => directoryRootPath(b).length - directoryRootPath(a).length)[0];
        if (!root) {
            return;
        }
        let current = directoryRootPath(root);
        state.directoryExpanded.add(current);
        await loadDirectoryChildren(current);
        const relative = directoryPath.slice(current.length)
            .split("/")
            .filter(Boolean);
        for (const segment of relative) {
            current = `${current.replace(/\/$/, "")}/${segment}`;
            state.directoryExpanded.add(current);
            await loadDirectoryChildren(current);
        }
        const listing = state.directoryCache.get(directoryPath);
        selectDirectoryNode({
            path: directoryPath,
            canSelect: listing?.canSelect ?? true,
        });
    }

    async function loadDirectoryRoots() {
        const result = await requestJson(apiUrl("directories", {
            archivePath: state.filePath,
        }));
        state.directoryRoots = result.roots || [];
        state.selectedDirectory = result.defaultPath || "";
        updateOutputPreview();
        updateActionAvailability();
        return result;
    }

    async function refreshDirectoryRoots() {
        const requestId = ++state.directoryRequestId;
        state.directoryCache.clear();
        state.directoryExpanded.clear();
        const result = await loadDirectoryRoots();
        if (requestId !== state.directoryRequestId) {
            return;
        }
        state.pendingDirectory = state.selectedDirectory;
        state.pendingDirectorySelectable = Boolean(state.pendingDirectory);
        renderDirectoryTree();
        if (state.pendingDirectory) {
            await revealDirectoryPath(state.pendingDirectory);
        }
    }

    async function openDirectoryDialog() {
        if (!state.info) {
            return;
        }
        els.directoryDialog.hidden = false;
        try {
            await refreshDirectoryRoots();
        } catch (error) {
            closeDirectoryDialog();
            setNotice(error.message, "error");
            if (!handlePermissionError(error)) {
                recordDiagnosticError(error);
            }
        }
    }

    function closeDirectoryDialog() {
        state.directoryRequestId += 1;
        els.directoryDialog.hidden = true;
    }

    function chooseBrowsingDirectory() {
        if (!state.pendingDirectorySelectable) {
            return;
        }
        state.selectedDirectory = state.pendingDirectory;
        updateOutputPreview();
        updateActionAvailability();
        closeDirectoryDialog();
    }

    async function goUpDirectory() {
        const root = currentBrowsingRoot();
        if (!root) {
            return;
        }
        const rootPath = directoryRootPath(root);
        const parent = state.pendingDirectory.replace(/\/[^/]+\/?$/, "") || "/";
        const target = pathWithin(rootPath, parent) ? parent : rootPath;
        try {
            const listing = await loadDirectoryChildren(target);
            selectDirectoryNode({
                path: target,
                canSelect: listing?.canSelect ?? (target === rootPath
                    ? (root.canSelect ?? true)
                    : false),
            });
        } catch (error) {
            setNotice(error.message, "error");
            if (!handlePermissionError(error)) {
                recordDiagnosticError(error);
            }
        }
    }

    function setCreateDirectoryError(message) {
        els.createDirectoryError.textContent = message || "";
        els.createDirectoryError.hidden = !message;
    }

    function openCreateDirectoryDialog() {
        if (!state.pendingDirectorySelectable) {
            return;
        }
        els.createDirectoryNameInput.value = "";
        setCreateDirectoryError("");
        els.createDirectoryDialog.hidden = false;
        els.createDirectoryNameInput.focus();
    }

    function closeCreateDirectoryDialog() {
        els.createDirectoryDialog.hidden = true;
        setCreateDirectoryError("");
    }

    async function createDirectory() {
        const name = els.createDirectoryNameInput.value.trim();
        if (!name) {
            setCreateDirectoryError("请输入文件夹名称。");
            return;
        }
        els.confirmCreateDirectoryBtn.disabled = true;
        try {
            const result = await postApi("create-directory", {
                archivePath: state.filePath,
                parentPath: state.pendingDirectory,
                name,
            });
            state.directoryCache.delete(state.pendingDirectory);
            await loadDirectoryChildren(state.pendingDirectory, true);
            state.directoryExpanded.add(state.pendingDirectory);
            closeCreateDirectoryDialog();
            selectDirectoryNode(result);
        } catch (error) {
            setCreateDirectoryError(error.message);
        } finally {
            els.confirmCreateDirectoryBtn.disabled = false;
        }
    }

    function setJobProgress(percent, status, currentFile) {
        const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
        els.progressFill.style.width = `${safePercent}%`;
        els.progressText.textContent = `${Math.round(safePercent)}%`;
        els.jobState.textContent = status;
        els.currentFile.textContent = currentFile || "正在等待任务状态...";
    }

    function statusLabel(status, phase) {
        if (status === "queued") {
            return "任务已排队";
        }
        if (status === "cancelling") {
            return "正在停止";
        }
        if (status === "cancelled") {
            return "已停止";
        }
        if (status === "success") {
            return "解压完成";
        }
        if (status === "failed") {
            return "解压失败";
        }
        return phase === "testing" ? "正在校验压缩包" : "正在解压";
    }

    function updateActionAvailability() {
        const hasPreview = state.previewReady || state.previewLimited;
        const hasSelection = state.previewLimited || state.selectedPaths.size > 0;
        const passwordReady = !state.passwordRequired || state.passwordVerified;
        const ready = Boolean(
            state.info
            && state.info.tool
            && state.selectedDirectory
            && hasPreview
            && hasSelection
            && passwordReady
            && !state.running,
        );
        els.extractBtn.disabled = !ready;
        els.cancelBtn.hidden = !state.running;
        els.refreshPreviewBtn.disabled = state.running || state.previewing || !state.info;
        els.codePageSelect.disabled = state.running || state.previewing;
        els.openPasswordManagerBtn.disabled = state.running || state.previewing || !state.info;
        els.passwordInput.disabled = state.running || state.previewing;
        els.passwordPresetToggleBtn.disabled = state.running || state.previewing;
        els.showPasswordInput.disabled = state.running || state.previewing;
        els.openPasswordManagerFromPromptBtn.disabled = state.running || state.previewing;
        els.verifyPasswordBtn.disabled = state.running || state.previewing;
        els.cancelPasswordBtn.disabled = state.running || state.previewing;
        els.addPasswordBtn.disabled = state.running || state.previewing;
        els.editPasswordBtn.disabled = state.running || state.previewing
            || !state.selectedManagerPasswordId;
        els.deletePasswordBtn.disabled = state.running || state.previewing
            || !state.selectedManagerPasswordId;
        els.recordPasswordInput.disabled = state.running || state.previewing;
        els.recordLabelInput.disabled = state.running || state.previewing;
        els.confirmPasswordRecordBtn.disabled = state.running || state.previewing;
        els.openDirectoryPickerBtn.disabled = state.running || !state.info;
        updatePasswordManagerStatus();
    }

    async function startExtract() {
        if (els.extractBtn.disabled) {
            return;
        }
        state.running = true;
        updateActionAvailability();
        setJobProgress(0, "正在创建任务", "正在校验设置...");
        setNotice("解压任务正在启动，请保持页面打开。");
        try {
            const selectedPaths = state.previewLimited
                || state.selectedPaths.size === state.allFilePaths.length
                ? null
                : Array.from(state.selectedPaths);
            const result = await postApi("extract", {
                path: state.filePath,
                password: els.passwordInput.value,
                codePage: els.codePageSelect.value,
                destinationRoot: state.selectedDirectory,
                selectedPaths,
            });
            state.jobId = result.jobId;
            els.outputPreview.textContent = result.outputDir;
            setJobProgress(0, "任务已排队", "等待 7-Zip 启动...");
            clearInterval(state.pollTimer);
            state.pollTimer = window.setInterval(pollStatus, 1000);
            await pollStatus();
        } catch (error) {
            state.running = false;
            setJobProgress(0, "启动失败", error.message);
            setNotice(error.message, "error");
            if (!handlePermissionError(error)) {
                recordDiagnosticError(error);
            }
            updateActionAvailability();
        }
    }

    async function pollStatus() {
        if (!state.jobId) {
            return;
        }
        try {
            const job = await requestJson(apiUrl("status", {
                jobId: state.jobId,
            }));
            setJobProgress(
                job.progress,
                statusLabel(job.status, job.phase),
                job.currentFile || (job.phase === "testing" ? "正在检查分卷和数据完整性..." : ""),
            );
            if (job.status === "success") {
                finishPolling();
                setJobProgress(100, "解压完成", job.outputDir);
                setNotice("解压任务已完成。", "success");
                els.resultOutputDir.textContent = job.outputDir;
                els.resultDialog.hidden = false;
            } else if (job.status === "failed") {
                finishPolling();
                const message = job.error?.message || "解压失败";
                const requestSuffix = job.requestId
                    ? `（请求 ID：${job.requestId}）`
                    : "";
                setJobProgress(job.progress, "解压失败", `${message}${requestSuffix}`);
                setNotice(message, "error");
                if (!handlePermissionError(job.error, job.requestId)) {
                    recordDiagnosticError(job.error, job.requestId);
                }
            } else if (job.status === "cancelled") {
                finishPolling();
                setJobProgress(job.progress, "已停止", "未完成的任务目录已清理。");
                setNotice("解压任务已停止。");
            }
        } catch (error) {
            setNotice(`状态查询失败：${error.message}`, "error");
            recordDiagnosticError(error);
        }
    }

    function finishPolling() {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
        state.running = false;
        state.jobId = "";
        updateActionAvailability();
    }

    async function cancelExtract() {
        if (!state.jobId || !state.running) {
            return;
        }
        els.cancelBtn.disabled = true;
        setJobProgress(
            Number.parseInt(els.progressText.textContent, 10) || 0,
            "正在停止",
            "正在终止 7-Zip 进程...",
        );
        try {
            await postApi("cancel", { jobId: state.jobId });
            await pollStatus();
        } catch (error) {
            setNotice(`停止任务失败：${error.message}`, "error");
            recordDiagnosticError(error);
        } finally {
            els.cancelBtn.disabled = false;
        }
    }

    function togglePasswordVisibility() {
        els.passwordInput.type = els.showPasswordInput.checked
            ? "text"
            : "password";
    }

    function closeResultDialog() {
        els.resultDialog.hidden = true;
    }

    async function retryPermissionAccess() {
        closePermissionDialog();
        setNotice("正在重新检测文件权限...");
        await loadApp();
    }

    function openPermissionDiagnostics() {
        closePermissionDialog();
        openDiagnostics();
    }

    async function loadApp() {
        renderSavedPasswords();
        state.filePath = getQueryPath();
        if (!state.filePath) {
            setToolStatus("未选择文件", "fail");
            setNotice("请从 fnOS 文件管理器右键打开受支持的压缩包或首卷文件。", "error");
            els.archiveTitle.textContent = "没有接收到文件路径";
            els.filePath.textContent = "支持普通压缩包、.7z.001、.zip.001、.part1.rar 等格式。";
            return;
        }

        try {
            setToolStatus("检测中");
            const info = await requestJson(apiUrl("info", {
                path: state.filePath,
            }));
            renderInfo(info);
            await loadDirectoryRoots();
            await loadPreview();
        } catch (error) {
            setToolStatus("不可用", "fail");
            setNotice(error.message, "error");
            els.archiveTitle.textContent = "无法打开压缩包";
            els.filePath.textContent = state.filePath;
            if (!handlePermissionError(error)) {
                recordDiagnosticError(error);
            }
        }
        updateActionAvailability();
    }

    els.refreshPreviewBtn.addEventListener("click", loadPreview);
    els.codePageSelect.addEventListener("change", loadPreview);
    els.passwordInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            verifyPasswordAndPreview();
        }
    });
    els.passwordInput.addEventListener("input", () => {
        const active = state.activeSavedPasswordId
            ? passwordStore.get(state.activeSavedPasswordId)
            : null;
        if (active && active.password !== els.passwordInput.value) {
            state.activeSavedPasswordId = "";
        }
        invalidatePasswordVerification();
        setPasswordPromptError("");
        updatePasswordManagerStatus();
    });
    els.passwordPresetToggleBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        togglePasswordPresetList();
    });
    els.showPasswordInput.addEventListener("change", togglePasswordVisibility);
    els.openPasswordManagerBtn.addEventListener("click", () => openPasswordManager("main"));
    els.openPasswordManagerFromPromptBtn.addEventListener("click", () => openPasswordManager("prompt"));
    els.closePasswordPromptDialogBtn.addEventListener("click", closePasswordPrompt);
    els.cancelPasswordBtn.addEventListener("click", closePasswordPrompt);
    els.verifyPasswordBtn.addEventListener("click", verifyPasswordAndPreview);
    els.closePasswordManagerDialogBtn.addEventListener("click", closePasswordManager);
    els.confirmPasswordManagerBtn.addEventListener("click", closePasswordManager);
    els.addPasswordBtn.addEventListener("click", () => openPasswordRecordDialog("add"));
    els.editPasswordBtn.addEventListener("click", () => openPasswordRecordDialog("edit"));
    els.deletePasswordBtn.addEventListener("click", deleteSelectedPassword);
    els.closePasswordRecordDialogBtn.addEventListener("click", closePasswordRecordDialog);
    els.cancelPasswordRecordBtn.addEventListener("click", closePasswordRecordDialog);
    els.confirmPasswordRecordBtn.addEventListener("click", savePasswordRecord);
    els.recordPasswordInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            savePasswordRecord();
        }
    });
    els.passwordPromptDialog.addEventListener("click", (event) => {
        if (event.target === els.passwordPromptDialog) {
            closePasswordPrompt();
        }
    });
    els.passwordManagerDialog.addEventListener("click", (event) => {
        if (event.target === els.passwordManagerDialog) {
            closePasswordManager();
        }
    });
    els.passwordRecordDialog.addEventListener("click", (event) => {
        if (event.target === els.passwordRecordDialog) {
            closePasswordRecordDialog();
        }
    });
    document.addEventListener("click", (event) => {
        if (
            state.passwordPresetOpen
            && !els.passwordPresetList.contains(event.target)
            && event.target !== els.passwordPresetToggleBtn
        ) {
            closePasswordPresetList();
        }
    });
    if (els.treeSearchInput) {
        els.treeSearchInput.addEventListener("input", () => {
            state.searchRenderId += 1;
            searchScheduler.schedule(renderTree);
        });
    }
    els.selectAllInput.addEventListener("change", () => {
        state.selectedPaths = els.selectAllInput.checked
            ? new Set(state.allFilePaths)
            : new Set();
        renderTree();
    });
    els.openDirectoryPickerBtn.addEventListener("click", openDirectoryDialog);
    els.closeDirectoryDialogBtn.addEventListener("click", closeDirectoryDialog);
    els.cancelDirectoryBtn.addEventListener("click", closeDirectoryDialog);
    els.chooseDirectoryBtn.addEventListener("click", chooseBrowsingDirectory);
    els.directoryUpBtn.addEventListener("click", goUpDirectory);
    els.refreshDirectoryRootsBtn.addEventListener("click", refreshDirectoryRoots);
    els.createDirectoryBtn.addEventListener("click", openCreateDirectoryDialog);
    els.cancelCreateDirectoryBtn.addEventListener("click", closeCreateDirectoryDialog);
    els.confirmCreateDirectoryBtn.addEventListener("click", createDirectory);
    els.createDirectoryNameInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            createDirectory();
        }
    });
    els.directoryDialog.addEventListener("click", (event) => {
        if (event.target === els.directoryDialog) {
            closeDirectoryDialog();
        }
    });
    els.createDirectoryDialog.addEventListener("click", (event) => {
        if (event.target === els.createDirectoryDialog) {
            closeCreateDirectoryDialog();
        }
    });
    els.extractBtn.addEventListener("click", startExtract);
    els.cancelBtn.addEventListener("click", cancelExtract);
    els.closeResultDialogBtn.addEventListener("click", closeResultDialog);
    els.confirmResultDialogBtn.addEventListener("click", closeResultDialog);
    els.resultDialog.addEventListener("click", (event) => {
        if (event.target === els.resultDialog) {
            closeResultDialog();
        }
    });
    els.diagnosticsBtn.addEventListener("click", openDiagnostics);
    els.closeDiagnosticsDialogBtn.addEventListener("click", closeDiagnostics);
    els.copyDiagnosticsBtn.addEventListener("click", () => {
        copyDiagnostics().catch((error) => {
            els.diagnosticsContent.textContent = `复制失败：${error.message}\n\n${diagnosticsText()}`;
        });
    });
    els.downloadDiagnosticsBtn.addEventListener("click", downloadDiagnostics);
    els.diagnosticsDialog.addEventListener("click", (event) => {
        if (event.target === els.diagnosticsDialog) {
            closeDiagnostics();
        }
    });
    els.closePermissionDialogBtn.addEventListener("click", closePermissionDialog);
    els.retryPermissionBtn.addEventListener("click", retryPermissionAccess);
    els.permissionDiagnosticsBtn.addEventListener("click", openPermissionDiagnostics);
    els.permissionDialog.addEventListener("click", (event) => {
        if (event.target === els.permissionDialog) {
            closePermissionDialog();
        }
    });

    loadApp();
}());
