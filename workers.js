// 不在公开仓库中保存城通密码；需要时通过请求的 pass 参数传入。
const DEFAULT_PASSWORD = "";
const API_ORIGIN = "https://webapi.ctfile.com";

addEventListener("fetch", (event) => {
    event.respondWith(
        handleRequest(event.request).catch((err) => {
            console.error("ctfile.Workers error:", err);
            return new Response(`解析失败：${err.message || "未知错误"}`, {
                status: 502,
                headers: { "content-type": "text/plain; charset=utf-8" },
            });
        })
    );
});

async function handleRequest(request) {
    const url = new URL(request.url);
    const { pathname } = url;
    const fileid = url.searchParams.get("file");
    const password = url.searchParams.get("pass") || DEFAULT_PASSWORD;
    const origin = url.origin;
    if (!password) {
        return new Response("缺少 pass 参数，或尚未配置默认密码", { status: 400 });
    }

    if (!["/directlink", "/proxylink", "/getlink"].some((path) => pathname.startsWith(path))) {
        return new Response("不支持的URL请求", { status: 404 });
    }
    if (!fileid) {
        return new Response("缺少 file 参数", { status: 400 });
    }

    const link = await fileToLink(fileid, password, origin);
    if (!link) {
        return new Response("没有获取到下载地址", { status: 404 });
    }

    if (pathname.startsWith("/directlink")) {
        return Response.redirect(link, 302);
    }
    if (pathname.startsWith("/proxylink")) {
        return fetch(link);
    }
    return new Response(link, {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
    });
}

async function readJson(response, name) {
    const text = await response.text();
    if (!text.trim()) {
        throw new Error(`${name}返回空响应（HTTP ${response.status}）`);
    }
    try {
        return JSON.parse(text);
    } catch (err) {
        throw new Error(`${name}返回的不是有效JSON（HTTP ${response.status}）`);
    }
}

async function fileToLink(fileid, password, origin) {
    if (!/^[A-Za-z0-9_-]+$/.test(fileid)) {
        throw new Error("file 参数格式不正确");
    }

    // 两段 ID 使用 file，三段及以上使用 f；与 ctfileGet 的实现保持一致。
    const path = fileid.split("-").length === 2 ? "file" : "f";
    const query = new URLSearchParams({
        path,
        f: fileid,
        passcode: password,
        token: "false",
        r: String(Math.random()),
        ref: origin,
    });
    const headers = {
        "origin": origin,
        "referer": `${origin}/`,
        "accept": "application/json, text/plain, */*",
    };

    const response = await fetch(`${API_ORIGIN}/getfile.php?${query}`, { headers });
    const fileInfo = await readJson(response, "getfile.php");
    if (Number(fileInfo.code) !== 200 || !fileInfo.file) {
        throw new Error(fileInfo.file?.message || fileInfo.message || "文件不存在或密码错误");
    }

    const file = fileInfo.file;
    if (Number(file.is_vip) === 1) {
        // VIP 文件的下载地址由 getfile.php 直接返回。
        const vipLink = file.vip_dx_url || file.vip_yd_url || file.vip_lt_url || file.us_downurl_a;
        if (!vipLink) {
            throw new Error("VIP 文件没有可用的下载地址");
        }
        return vipLink;
    }

    if (!file.userid || !file.file_id || !file.file_chk) {
        throw new Error("getfile.php 返回的数据缺少 userid/file_id/file_chk");
    }

    // 当前城通公开分享接口使用 get_down_url.php；旧的 get_file_url.php
    // 仍可能返回 HTTP 200，但正文为空，不能再对它做 JSON.parse。
    const url = new URL(`${API_ORIGIN}/get_down_url.php`);
    url.search = new URLSearchParams({
        uid: String(file.userid),
        fid: String(file.file_id),
        file_chk: String(file.file_chk),
        start_time: String(file.start_time || Math.floor(Date.now() / 1000)),
        wait_seconds: String(file.wait_seconds || 0),
        rd: String(Math.random()),
    });
    const response2 = await fetch(url, { headers });
    const linkInfo = await readJson(response2, "get_down_url.php");
    if (Number(linkInfo.code) === 200 && linkInfo.downurl) {
        return linkInfo.downurl;
    }
    if (Number(linkInfo.code) === 302) {
        throw new Error("该文件需要登录城通账号");
    }
    throw new Error(linkInfo.message || "获取下载地址失败");
}
