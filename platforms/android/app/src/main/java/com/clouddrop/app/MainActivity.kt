package com.clouddrop.app

import android.annotation.SuppressLint
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Base64
import android.webkit.*
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var pageLoaded = false
    private var pendingSharePayload: String? = null

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val uris = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
        filePathCallback?.onReceiveValue(uris)
        filePathCallback = null
    }

    private inner class AndroidBridge {
        @JavascriptInterface
        fun saveFile(fileName: String, mimeType: String, base64Data: String): Boolean {
            return try {
                val bytes = Base64.decode(base64Data, Base64.DEFAULT)
                val safeName = fileName.ifBlank { "clouddrop_${System.currentTimeMillis()}" }
                val safeMime = mimeType.ifBlank { "application/octet-stream" }

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    val values = ContentValues().apply {
                        put(MediaStore.Downloads.DISPLAY_NAME, safeName)
                        put(MediaStore.Downloads.MIME_TYPE, safeMime)
                        put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/CloudDrop")
                    }
                    val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                        ?: return false
                    contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
                } else {
                    @Suppress("DEPRECATION")
                    val dir = File(
                        Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                        "CloudDrop"
                    )
                    dir.mkdirs()
                    FileOutputStream(File(dir, safeName)).use { it.write(bytes) }
                }

                runOnUiThread {
                    Toast.makeText(this@MainActivity, "已保存到 下载/CloudDrop/$safeName", Toast.LENGTH_SHORT).show()
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
                    view: WebView,
                    request: WebResourceRequest
                ): WebResourceResponse? {
                    return assetLoader.shouldInterceptRequest(request.url)
                }

                override fun shouldOverrideUrlLoading(
                    view: WebView,
                    request: WebResourceRequest
                ): Boolean {
                    val host = request.url.host ?: return false
                    if (host == "appassets.androidplatform.net" ||
                        host.endsWith("microsoftonline.com") ||
                        host.endsWith("live.com")
                    ) {
                        return false
                    }
                    return try {
                        startActivity(Intent(Intent.ACTION_VIEW, request.url))
                        true
                    } catch (_: Exception) {
                        false
                    }
                }

                override fun onPageFinished(view: WebView, url: String) {
                    super.onPageFinished(view, url)
                    pageLoaded = true
                    flushPendingShare()
                }
            }

            webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(
                    webView: WebView,
                    callback: ValueCallback<Array<Uri>>,
                    params: FileChooserParams
                ): Boolean {
                    filePathCallback?.onReceiveValue(null)
                    filePathCallback = callback
                    return try {
                        fileChooserLauncher.launch(params.createIntent())
                        true
                    } catch (_: Exception) {
                        filePathCallback = null
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
