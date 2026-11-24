package com.clouddrop.app

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.MimeTypeMap
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var pageLoaded = false
    private var pendingSharePayload: String? = null

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val callback = filePathCallback
        filePathCallback = null
        if (callback == null) return@registerForActivityResult

        if (result.resultCode != RESULT_OK || result.data == null) {
            callback.onReceiveValue(null)
            return@registerForActivityResult
        }

        val data = result.data!!
        val uris = mutableListOf<Uri>()

        // Multi-select results are returned in clipData (FileChooserParams.parseResult ignores clipData!)
        val clip = data.clipData
        if (clip != null && clip.itemCount > 0) {
            for (i in 0 until clip.itemCount) {
                clip.getItemAt(i)?.uri?.let { uris.add(it) }
            }
        } else {
            data.data?.let { uris.add(it) }
        }

        if (uris.isEmpty()) {
            val fallback = WebChromeClient.FileChooserParams.parseResult(result.resultCode, data)
            callback.onReceiveValue(fallback)
        } else {
            callback.onReceiveValue(uris.toTypedArray())
        }
    }

    private data class PendingSaveSession(
        val fileName: String,
        val displayPath: String,
        val outputStream: OutputStream,
        val mediaUri: Uri? = null,
        val directFile: File? = null
    )

    private val saveSessions = ConcurrentHashMap<String, PendingSaveSession>()

    private fun resolveSafeMime(fileName: String, rawMime: String): String {
        val trimmed = rawMime.trim()
        if (trimmed.isNotEmpty() && trimmed != "application/octet-stream") return trimmed
        val ext = fileName.substringAfterLast('.', "").lowercase()
        if (ext.isNotEmpty()) {
            MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)?.let { return it }
        }
        return "application/octet-stream"
    }

    private fun openDownloadSession(fileName: String, mimeType: String): PendingSaveSession {
        val safeName = fileName.replace(Regex("[\\\\/:*?\"<>|]"), "_").ifBlank { "clouddrop_${System.currentTimeMillis()}" }
        val safeMime = resolveSafeMime(safeName, mimeType)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            // Try Download/CloudDrop/ first (trailing slash is required by Android 10 / HarmonyOS!),
            // then fall back to Download/ root if strict OEM MediaStore rejects subfolder.
            val candidateDirs = listOf(
                Environment.DIRECTORY_DOWNLOADS + "/CloudDrop/",
                Environment.DIRECTORY_DOWNLOADS + "/"
            )
            for (relDir in candidateDirs) {
                try {
                    val values = ContentValues().apply {
                        put(MediaStore.MediaColumns.DISPLAY_NAME, safeName)
                        put(MediaStore.MediaColumns.MIME_TYPE, safeMime)
                        put(MediaStore.MediaColumns.RELATIVE_PATH, relDir)
                        put(MediaStore.MediaColumns.IS_PENDING, 1)
                    }
                    val uri = contentResolver.insert(collection, values)
                    if (uri != null) {
                        val os = contentResolver.openOutputStream(uri, "w")
                        if (os != null) {
                            return PendingSaveSession(
                                fileName = safeName,
                                displayPath = "${relDir}$safeName",
                                outputStream = os,
                                mediaUri = uri
                            )
                        }
                        contentResolver.delete(uri, null, null)
                    }
                } catch (_: Exception) {
                    // try next fallback location
                }
            }
            // Last-resort app-specific external Downloads folder (always writable, visible in Android/data/com.clouddrop.app/files/Download)
            val fallbackDir = File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: filesDir, "CloudDrop")
            fallbackDir.mkdirs()
            val outFile = File(fallbackDir, safeName)
            return PendingSaveSession(
                fileName = safeName,
                displayPath = outFile.absolutePath,
                outputStream = FileOutputStream(outFile),
                directFile = outFile
            )
        } else {
            @Suppress("DEPRECATION")
            val dir = File(
                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                "CloudDrop"
            )
            dir.mkdirs()
            val outFile = File(dir, safeName)
            return PendingSaveSession(
                fileName = safeName,
                displayPath = "Download/CloudDrop/$safeName",
                outputStream = FileOutputStream(outFile),
                directFile = outFile
            )
        }
    }

    private fun finalizeDownloadSession(session: PendingSaveSession) {
        session.outputStream.flush()
        session.outputStream.close()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && session.mediaUri != null) {
            val done = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
            contentResolver.update(session.mediaUri, done, null, null)
            // Notify Huawei/HarmonyOS & Android media scanner so file managers show the file immediately
            val absPath = File(
                Environment.getExternalStorageDirectory(),
                session.displayPath
            ).absolutePath
            MediaScannerConnection.scanFile(this, arrayOf(absPath), null, null)
        } else if (session.directFile != null) {
            MediaScannerConnection.scanFile(this, arrayOf(session.directFile.absolutePath), null, null)
        }
    }

    private inner class AndroidBridge {
        @JavascriptInterface
        fun copyText(text: String): Boolean {
            return try {
                runOnUiThread {
                    val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    cm.setPrimaryClip(ClipData.newPlainText("CloudDrop", text))
                }
                true
            } catch (_: Exception) {
                false
            }
        }

        // Chunked streaming saver for files of any size (avoids WebView JNI OOM on large files!)
        @JavascriptInterface
        fun beginSaveFile(fileName: String, mimeType: String): String {
            return try {
                val session = openDownloadSession(fileName, mimeType)
                val token = UUID.randomUUID().toString()
                saveSessions[token] = session
                JSONObject().apply {
                    put("ok", true)
                    put("token", token)
                    put("path", session.displayPath)
                }.toString()
            } catch (e: Exception) {
                JSONObject().apply {
                    put("ok", false)
                    put("error", e.message ?: "无法创建本地文件")
                }.toString()
            }
        }

        @JavascriptInterface
        fun appendSaveChunk(token: String, base64Chunk: String): Boolean {
            val session = saveSessions[token] ?: return false
            return try {
                val bytes = Base64.decode(base64Chunk, Base64.DEFAULT)
                session.outputStream.write(bytes)
                true
            } catch (_: Exception) {
                false
            }
        }

        @JavascriptInterface
        fun finishSaveFile(token: String): String {
            val session = saveSessions.remove(token)
                ?: return JSONObject().apply {
                    put("ok", false)
                    put("error", "保存会话不存在")
                }.toString()
            return try {
                finalizeDownloadSession(session)
                runOnUiThread {
                    Toast.makeText(this@MainActivity, "已保存到 ${session.displayPath}", Toast.LENGTH_LONG).show()
                }
                JSONObject().apply {
                    put("ok", true)
                    put("path", session.displayPath)
                }.toString()
            } catch (e: Exception) {
                runOnUiThread {
                    Toast.makeText(this@MainActivity, "保存失败: ${e.message}", Toast.LENGTH_LONG).show()
                }
                JSONObject().apply {
                    put("ok", false)
                    put("error", e.message ?: "完成写入失败")
                }.toString()
            }
        }

        @JavascriptInterface
        fun cancelSaveFile(token: String) {
            val session = saveSessions.remove(token) ?: return
            try {
                session.outputStream.close()
            } catch (_: Exception) {}
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && session.mediaUri != null) {
                try {
                    contentResolver.delete(session.mediaUri, null, null)
                } catch (_: Exception) {}
            } else {
                session.directFile?.delete()
            }
        }

        // Legacy single-shot saver kept for small files & backwards compatibility
        @JavascriptInterface
        fun saveFile(fileName: String, mimeType: String, base64Data: String): Boolean {
            return try {
                val bytes = Base64.decode(base64Data, Base64.DEFAULT)
                val session = openDownloadSession(fileName, mimeType)
                session.outputStream.write(bytes)
                finalizeDownloadSession(session)
                runOnUiThread {
                    Toast.makeText(this@MainActivity, "已保存到 ${session.displayPath}", Toast.LENGTH_LONG).show()
                }
                true
            } catch (e: Exception) {
                runOnUiThread {
                    Toast.makeText(this@MainActivity, "保存失败: ${e.message}", Toast.LENGTH_LONG).show()
                }
                false
            }
        }
    }

    private val allowedOneDriveSuffixes = listOf(
        ".1drv.com",
        ".microsoftpersonalcontent.com",
        ".sharepoint.com",
        ".livefilestore.com",
        ".onedrive.com",
        ".svc.ms"
    )

    private fun isAllowedOneDriveUrl(rawUrl: String): Boolean {
        return try {
            val u = URL(rawUrl)
            if (u.protocol != "https") return false
            val host = (u.host ?: "").lowercase()
            host == "graph.microsoft.com" || allowedOneDriveSuffixes.any { host.endsWith(it) }
        } catch (_: Exception) {
            false
        }
    }

    private fun handleOneDriveProxy(targetUrl: String?): WebResourceResponse {
        val corsHeaders = mapOf(
            "Access-Control-Allow-Origin" to "https://appassets.androidplatform.net",
            "Cache-Control" to "no-store"
        )
        if (targetUrl.isNullOrBlank() || !isAllowedOneDriveUrl(targetUrl)) {
            return WebResourceResponse(
                "text/plain",
                "UTF-8",
                403,
                "Forbidden",
                corsHeaders,
                ByteArrayInputStream("Disallowed proxy host".toByteArray())
            )
        }
        return try {
            val conn = (URL(targetUrl).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                instanceFollowRedirects = true
                connectTimeout = 20000
                readTimeout = 30000
                setRequestProperty("User-Agent", "CloudDrop-Android/1.0")
            }
            val code = conn.responseCode
            val rawType = conn.contentType ?: "application/octet-stream"
            val mimeType = rawType.substringBefore(";").trim().ifEmpty { "application/octet-stream" }
            val reason = conn.responseMessage?.ifBlank { null } ?: if (code in 200..299) "OK" else "Error"
            val stream = if (code in 200..299) conn.inputStream else (conn.errorStream ?: ByteArrayInputStream(ByteArray(0)))
            val bytes = stream.use { it.readBytes() }
            conn.disconnect()
            WebResourceResponse(
                mimeType,
                if (mimeType.startsWith("text/") || mimeType == "application/json") "UTF-8" else null,
                code,
                reason,
                corsHeaders,
                ByteArrayInputStream(bytes)
            )
        } catch (e: Exception) {
            val msg = "Proxy error: ${e.message ?: "network failure"}"
            WebResourceResponse(
                "text/plain",
                "UTF-8",
                502,
                "Bad Gateway",
                corsHeaders,
                ByteArrayInputStream(msg.toByteArray())
            )
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.allowFileAccess = false
            settings.javaScriptCanOpenWindowsAutomatically = true
            settings.setSupportMultipleWindows(false)
            addJavascriptInterface(AndroidBridge(), "AndroidBridge")

            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView?,
                    request: WebResourceRequest?
                ): WebResourceResponse? {
                    val url = request?.url ?: return null
                    if (url.host == "appassets.androidplatform.net") {
                        val path = url.path ?: ""
                        if (path == "/api/onedrive-proxy") {
                            return handleOneDriveProxy(url.getQueryParameter("url"))
                        }
                        if (path.isEmpty() || path == "/" || path == "/assets" || path == "/assets/") {
                            val indexUri = Uri.parse("https://appassets.androidplatform.net/assets/index.html")
                            return assetLoader.shouldInterceptRequest(indexUri)
                        }
                        if (!path.startsWith("/assets/")) {
                            val fixedUri = Uri.parse("https://appassets.androidplatform.net/assets$path")
                            return assetLoader.shouldInterceptRequest(fixedUri)
                        }
                    }
                    return assetLoader.shouldInterceptRequest(url)
                }

                override fun shouldOverrideUrlLoading(
                    view: WebView?,
                    request: WebResourceRequest?
                ): Boolean {
                    val uri = request?.url ?: return false
                    val host = uri.host ?: return false

                    // Rewrite OAuth callbacks like /assets?code=... to /assets/index.html?code=...
                    // so WebViewAssetLoader serves index.html and relative ./assets paths resolve cleanly.
                    if (host == "appassets.androidplatform.net") {
                        val path = uri.path ?: ""
                        if (path.isEmpty() || path == "/" || path == "/assets" || path == "/assets/") {
                            val query = uri.encodedQuery
                            val fragment = uri.encodedFragment
                            val target = buildString {
                                append("https://appassets.androidplatform.net/assets/index.html")
                                if (!query.isNullOrEmpty()) append("?").append(query)
                                if (!fragment.isNullOrEmpty()) append("#").append(fragment)
                            }
                            view?.loadUrl(target)
                            return true
                        }
                        return false
                    }

                    if (host.endsWith("microsoftonline.com") ||
                        host.endsWith("live.com") ||
                        host.endsWith("msauth.net") ||
                        host.endsWith("msftauth.net") ||
                        host.endsWith("microsoft.com")
                    ) {
                        return false
                    }
                    return try {
                        startActivity(Intent(Intent.ACTION_VIEW, uri))
                        true
                    } catch (_: Exception) {
                        false
                    }
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    pageLoaded = true
                    flushPendingShare()
                }
            }

            webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(
                    webView: WebView?,
                    filePathCallback: ValueCallback<Array<Uri>>?,
                    fileChooserParams: FileChooserParams?
                ): Boolean {
                    this@MainActivity.filePathCallback?.onReceiveValue(null)
                    this@MainActivity.filePathCallback = filePathCallback
                    val allowMultiple =
                        fileChooserParams?.mode == FileChooserParams.MODE_OPEN_MULTIPLE
                    val pickerIntent = Intent(Intent.ACTION_GET_CONTENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "*/*"
                        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, allowMultiple)
                        val accepts = fileChooserParams?.acceptTypes?.filter { it.isNotBlank() }
                        if (!accepts.isNullOrEmpty() && !accepts.contains("*/*")) {
                            putExtra(Intent.EXTRA_MIME_TYPES, accepts.toTypedArray())
                        }
                    }
                    return try {
                        fileChooserLauncher.launch(Intent.createChooser(pickerIntent, "选择文件"))
                        true
                    } catch (_: Exception) {
                        this@MainActivity.filePathCallback = null
                        false
                    }
                }
            }
        }

        setContentView(webView)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })

        webView.loadUrl("https://appassets.androidplatform.net/assets/index.html")
        handleShareIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleShareIntent(intent)
    }

    private fun handleShareIntent(intent: Intent?) {
        if (intent == null) return
        val action = intent.action
        if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return

        val text = intent.getStringExtra(Intent.EXTRA_TEXT) ?: ""
        val filesJson = JSONArray()

        val uris = mutableListOf<Uri>()
        if (action == Intent.ACTION_SEND) {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)?.let { uris.add(it) }
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.let { uris.addAll(it) }
        }

        for (uri in uris) {
            try {
                val bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: continue
                if (bytes.size > 15 * 1024 * 1024) continue
                val name = queryFileName(uri) ?: "shared_${System.currentTimeMillis()}"
                val mime = contentResolver.getType(uri) ?: "application/octet-stream"
                filesJson.put(JSONObject().apply {
                    put("name", name)
                    put("mimeType", mime)
                    put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
                })
            } catch (_: Exception) {
                // skip unreadable URI
            }
        }

        if (text.isNotEmpty() || filesJson.length() > 0) {
            val payload = JSONObject().apply {
                put("text", text)
                put("files", filesJson)
            }
            pendingSharePayload = payload.toString()
            flushPendingShare()
        }
    }

    private fun flushPendingShare() {
        val payload = pendingSharePayload ?: return
        if (!pageLoaded) return
        pendingSharePayload = null
        val js = "window.__CLOUDDROP_NATIVE_SHARE__ && window.__CLOUDDROP_NATIVE_SHARE__($payload);"
        webView.post { webView.evaluateJavascript(js, null) }
    }

    private fun queryFileName(uri: Uri): String? {
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) return c.getString(0)
        }
        return uri.lastPathSegment
    }
}
