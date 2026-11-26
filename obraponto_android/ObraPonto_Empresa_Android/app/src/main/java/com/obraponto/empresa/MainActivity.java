package com.obraponto.empresa;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.WindowInsets;
import android.graphics.Insets;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.InputMethodManager;
import android.content.Context;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.DownloadListener;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import java.io.OutputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import android.print.PrintManager;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintDocumentInfo;
import android.print.PageRange;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.util.Base64;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;
import org.json.JSONObject;

/** ObraPonto mobile — cliente Android separado ligado ao mesmo servidor HTTPS. */
public class MainActivity extends Activity {
    private static final String PREFS = "obraponto_mobile_prefs";
    private static final String SERVER_KEY = "server_origin";
    private static final String DEFAULT_ORIGIN = BuildConfig.DEFAULT_ORIGIN;
    private static final int SAVE_CSV = 4096;
    private static final int NAVY = Color.rgb(16, 44, 75);
    private static final int CARD = Color.rgb(22, 55, 87);
    private static final int MINT = Color.rgb(255, 167, 63);
    private static final String APP_ROUTE = "/admin/";
    private static final String APP_TITLE = "ObraPonto Empresa";
    private static final String APP_TAG = "Empresa";
    private WebView webView;
    private ProgressBar progress;
    private FrameLayout mainFrame;
    private String origin;
    private String pendingCsv;
    private boolean displayError;

    private int dp(float value) {
        return (int)(value * getResources().getDisplayMetrics().density + 0.5f);
    }
    private GradientDrawable bg(int color, int radius) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(color); d.setCornerRadius(dp(radius)); return d;
    }
    private TextView text(String value, int size, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(value); t.setTextSize(size); t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return t;
    }
    private LinearLayout vertical() {
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.VERTICAL);
        return l;
    }
    // Android 15/16: a janela é edge-to-edge; reserve barras, recortes e teclado.
    private void installRoot(View root) {
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                Insets safe = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                Insets ime = insets.getInsets(WindowInsets.Type.ime());
                v.setPadding(safe.left, safe.top, safe.right, Math.max(safe.bottom, ime.bottom));
                return WindowInsets.CONSUMED;
            }
            v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });
        setContentView(root);
        root.requestApplyInsets();
    }
    private String settingsOrigin() {
        return getSharedPreferences(PREFS, MODE_PRIVATE).getString(SERVER_KEY, DEFAULT_ORIGIN);
    }
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        getWindow().setStatusBarColor(NAVY);
        getWindow().setNavigationBarColor(NAVY);
        origin = settingsOrigin();
        if (origin.isEmpty()) showSetup(false); else showApp();
    }
    private String validateOrigin(String input) {
        try {
            input = input.trim();
            if (input.isEmpty()) return null;
            if (!input.contains("://")) input = "https://" + input;
            URI uri = new URI(input);
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null ||
                uri.getUserInfo() != null || uri.getPort() > 65535 ||
                uri.getQuery() != null || uri.getFragment() != null) return null;
            String host = uri.getHost().toLowerCase(Locale.ROOT);
            if (host.equals("localhost") || host.equals("127.0.0.1") || host.endsWith(".local")) return null;
            String clean = uri.getScheme().toLowerCase(Locale.ROOT) + "://" + host;
            if (uri.getPort() != -1) clean += ":" + uri.getPort();
            return clean;
        } catch (URISyntaxException e) { return null; }
    }
    private void showSetup(boolean editing) {
        if (webView != null) { if (webView.getParent() instanceof ViewGroup) ((ViewGroup)webView.getParent()).removeView(webView); webView.destroy(); webView = null; }
        LinearLayout root = vertical();
        root.setBackgroundColor(NAVY);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        ScrollView scroll = new ScrollView(this);
        root.addView(scroll, new LinearLayout.LayoutParams(-1, -1));
        LinearLayout content = vertical(); content.setPadding(dp(30), dp(35), dp(30), dp(40));
        scroll.addView(content);
        ImageView logo = new ImageView(this);
        logo.setImageResource(R.drawable.brand_logo);
        logo.setScaleType(ImageView.ScaleType.FIT_CENTER);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(108), dp(108));
        lp.gravity = Gravity.CENTER_HORIZONTAL; lp.bottomMargin = dp(26);
        content.addView(logo, lp);
        TextView kicker = text("OBRAPONTO  •  " + APP_TAG, 12, MINT, true);
        kicker.setGravity(Gravity.CENTER); content.addView(kicker);
        TextView title = text("Conectar à empresa", 29, Color.WHITE, true);
        title.setGravity(Gravity.CENTER); title.setPadding(0, dp(10), 0, dp(8)); content.addView(title);
        TextView intro = text("Configure o endereço HTTPS do servidor da empresa. Depois disso, seus dados serão sincronizados pela internet.", 15, 0xffbbc7d9, false);
        intro.setGravity(Gravity.CENTER); intro.setLineSpacing(dp(3), 1.0f);
        content.addView(intro);
        LinearLayout panel = vertical(); panel.setPadding(dp(18), dp(22), dp(18), dp(20));
        panel.setBackground(bg(CARD, 19));
        LinearLayout.LayoutParams pp = new LinearLayout.LayoutParams(-1,-2);
        pp.topMargin = dp(32); content.addView(panel, pp);
        TextView label = text("Endereço do servidor", 14, Color.WHITE, true);
        panel.addView(label);
        EditText address = new EditText(this);
        address.setTextColor(Color.WHITE); address.setHintTextColor(0xff75879e);
        address.setTextSize(15); address.setSingleLine(true);
        address.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        address.setHint("https://ponto.suaempresa.com.br");
        address.setText(origin);
        address.setPadding(dp(14), 0, dp(14), 0);
        address.setBackground(bg(0xff101c31, 12));
        LinearLayout.LayoutParams ep = new LinearLayout.LayoutParams(-1, dp(55)); ep.topMargin = dp(10);
        panel.addView(address, ep);
        TextView note = text("Use o MESMO endereço nos dois aplicativos. Não inclua /admin ou /funcionario.", 12, 0xff97a9c1, false);
        note.setPadding(0, dp(12), 0, dp(14)); panel.addView(note);
        Button connect = new Button(this);
        connect.setText("CONECTAR  →"); connect.setTextColor(NAVY);
        connect.setTextSize(15); connect.setAllCaps(false);
        connect.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        connect.setBackground(bg(MINT, 12));
        panel.addView(connect, new LinearLayout.LayoutParams(-1, dp(54)));
        connect.setOnClickListener(v -> {
            String url = validateOrigin(address.getText().toString());
            if (url == null) {
                address.setError("Digite um endereço HTTPS válido, ex.: https://ponto.suaempresa.com.br");
                return;
            }
            origin = url;
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(SERVER_KEY, url).apply();
            try { ((InputMethodManager)getSystemService(Context.INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(address.getWindowToken(), 0); } catch(Exception ignored) {}
            showApp();
        });
        if (editing) {
            TextView cancel = text("Voltar ao aplicativo", 14, 0xffa7bbd5, false);
            cancel.setGravity(Gravity.CENTER);
            cancel.setPadding(0, dp(25), 0, dp(5));
            cancel.setOnClickListener(v -> { origin=settingsOrigin(); showApp(); });
            content.addView(cancel);
        }
        TextView foot = text(""+APP_TITLE+"  •  Acesso protegido por HTTPS", 11, 0xff8499b1, false);
        foot.setGravity(Gravity.CENTER); foot.setPadding(0, dp(26), 0, 0);
        content.addView(foot);
        installRoot(root);
    }
    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void showApp() {
        displayError=false;
        LinearLayout root = vertical(); root.setBackgroundColor(NAVY);
        LinearLayout bar = new LinearLayout(this);
        bar.setGravity(Gravity.CENTER_VERTICAL); bar.setPadding(dp(15), 0, dp(10), 0);
        bar.setBackgroundColor(NAVY);
        root.addView(bar, new LinearLayout.LayoutParams(-1, dp(49)));
        TextView heading = text("●  ObraPonto  /  "+APP_TAG, 15, Color.WHITE, true);
        heading.setGravity(Gravity.CENTER_VERTICAL);
        bar.addView(heading, new LinearLayout.LayoutParams(0, -1, 1));
        TextView settings = text("⚙  Servidor", 12, 0xffd6e6ef, false);
        settings.setGravity(Gravity.CENTER); settings.setPadding(dp(13), 0, dp(5), 0);
        settings.setOnClickListener(v -> showSetup(true));
        bar.addView(settings, new LinearLayout.LayoutParams(-2, -1));
        FrameLayout body = new FrameLayout(this);
        root.addView(body, new LinearLayout.LayoutParams(-1, 0, 1));
        mainFrame=body;
        webView = new WebView(this);
        webView.setBackgroundColor(NAVY);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false); s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        if (Build.VERSION.SDK_INT >= 26) s.setSafeBrowsingEnabled(true);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        s.setGeolocationEnabled(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view, int newProgress) {
                if (progress != null) progress.setVisibility(newProgress < 100 ? View.VISIBLE : View.GONE);
            }
        });
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u=request.getUrl();
                Uri home=Uri.parse(origin);
                boolean same = "https".equalsIgnoreCase(u.getScheme()) &&
                    home.getHost()!=null && home.getHost().equalsIgnoreCase(u.getHost()) &&
                    home.getPort()==u.getPort();
                if (same) return false;
                if ("https".equalsIgnoreCase(u.getScheme()) || "mailto".equalsIgnoreCase(u.getScheme()) || "tel".equalsIgnoreCase(u.getScheme())) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (ActivityNotFoundException ignored) {}
                }
                return true;
            }
            @Override public void onPageFinished(WebView view, String url) {
                if ("empresa".equals(APP_TAG.toLowerCase(Locale.ROOT))) installExportHook();
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame() && !displayError) {
                    displayError=true;
                    showConnectionError();
                }
            }
        });
        webView.addJavascriptInterface(new MobileBridge(), "ObraPontoAndroid");
        webView.setDownloadListener((url, agent, disposition, mime, len) -> {
            if (url.startsWith("blob:")) {
                String js="(function(){fetch("+JSONObject.quote(url)+").then(r=>r.blob()).then(b=>{let f=new FileReader();f.onload=()=>ObraPontoAndroid.saveCsv(String(f.result),'relatorio-obraponto.csv');f.readAsDataURL(b);}).catch(()=>{});})()";
                webView.evaluateJavascript(js,null);
            } else if (url.startsWith(origin+"/")) {
                try {startActivity(new Intent(Intent.ACTION_VIEW,Uri.parse(url)));} catch(Exception ignored) {}
            }
        });
        body.addView(webView, new FrameLayout.LayoutParams(-1,-1));
        progress = new ProgressBar(this,null,android.R.attr.progressBarStyleHorizontal);
        progress.setIndeterminate(true);
        progress.setProgressTintList(android.content.res.ColorStateList.valueOf(MINT));
        FrameLayout.LayoutParams pp=new FrameLayout.LayoutParams(-1,dp(3),Gravity.TOP);
        body.addView(progress,pp);
        installRoot(root);
        webView.loadUrl(origin + APP_ROUTE);
    }
    private void installExportHook() {
        if (webView == null) return;
        // O botão CSV existente usa um blob:; interceptar permite salvar no Android.
        String script="(function(){if(window.__obraAndroidCsv)return;window.__obraAndroidCsv=true;document.addEventListener('click',function(ev){var el=ev.target.closest('a[download]');if(!el || !el.href.startsWith('blob:'))return;ev.preventDefault();ev.stopImmediatePropagation();var name=el.getAttribute('download')||'relatorio-obraponto.csv';fetch(el.href).then(r=>r.blob()).then(b=>{var f=new FileReader();f.onload=function(){ObraPontoAndroid.saveCsv(String(f.result),name);};f.readAsDataURL(b);});},true);})()";
        webView.evaluateJavascript(script,null);
    }
    private class MobileBridge {
        @JavascriptInterface public void printPdf(String dataUrl,String filename) {
            printPdfDocument(dataUrl,filename);
        }
        @JavascriptInterface public void saveCsv(String dataUrl,String name) {
            runOnUiThread(() -> {
                if (dataUrl==null || !dataUrl.startsWith("data:") || dataUrl.length()>20000000) return;
                pendingCsv=dataUrl;
                Intent i=new Intent(Intent.ACTION_CREATE_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                String sanitized=(name==null?"relatorio-obraponto.csv":name).replaceAll("[^a-zA-Z0-9._-]","_");
                String ext=sanitized.toLowerCase(Locale.ROOT);
                i.setType(ext.endsWith(".pdf")?"application/pdf":ext.endsWith(".xlsx")?"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":"text/csv");
                i.putExtra(Intent.EXTRA_TITLE,sanitized);
                try {startActivityForResult(i,SAVE_CSV);} catch(Exception e){Toast.makeText(MainActivity.this,"Não foi possível abrir o salvamento",Toast.LENGTH_LONG).show();}
            });
        }
    }
    /** Envia o PDF recebido da API diretamente ao diálogo de impressão do Android. */
    private void printPdfDocument(String dataUrl,String filename) {
        if(dataUrl == null || dataUrl.length() > 20000000 ||
           !dataUrl.startsWith("data:application/pdf;base64,")) {
            runOnUiThread(() -> Toast.makeText(this,"PDF inválido ou grande demais",Toast.LENGTH_LONG).show());
            return;
        }
        try {
            byte[] bytes=Base64.decode(dataUrl.substring(dataUrl.indexOf(',')+1),Base64.DEFAULT);
            if(bytes.length<5 || !"%PDF-".equals(new String(bytes,0,5,StandardCharsets.US_ASCII))) {
                throw new IllegalArgumentException("Formato PDF incorreto");
            }
            final String safeName=(filename==null?"relatorio-obraponto.pdf":filename).replaceAll("[^a-zA-Z0-9._-]","_");
            runOnUiThread(() -> {
                try {
                    PrintManager manager=(PrintManager)getSystemService(Context.PRINT_SERVICE);
                    if(manager==null)throw new IllegalStateException("Serviço de impressão indisponível");
                    PrintDocumentAdapter adapter=new PrintDocumentAdapter() {
                        @Override public void onLayout(PrintAttributes oldAttributes,PrintAttributes newAttributes,
                            CancellationSignal cancellationSignal,LayoutResultCallback callback,Bundle extras) {
                            if(cancellationSignal.isCanceled()) {callback.onLayoutCancelled();return;}
                            PrintDocumentInfo info=new PrintDocumentInfo.Builder(safeName)
                                .setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT)
                                .setPageCount(PrintDocumentInfo.PAGE_COUNT_UNKNOWN).build();
                            callback.onLayoutFinished(info,true);
                        }
                        @Override public void onWrite(PageRange[] pages,ParcelFileDescriptor destination,
                            CancellationSignal cancellationSignal,WriteResultCallback callback) {
                            if(cancellationSignal.isCanceled()) {callback.onWriteCancelled();return;}
                            try(FileOutputStream out=new FileOutputStream(destination.getFileDescriptor())) {
                                out.write(bytes);out.flush();
                                if(cancellationSignal.isCanceled())callback.onWriteCancelled();
                                else callback.onWriteFinished(new PageRange[]{PageRange.ALL_PAGES});
                            }catch(Exception e){callback.onWriteFailed("Falha ao preparar impressão do PDF");}
                        }
                    };
                    manager.print("ObraPonto - "+safeName,adapter,
                        new PrintAttributes.Builder().setMediaSize(PrintAttributes.MediaSize.ISO_A4).build());
                }catch(Exception e){
                    Toast.makeText(this,"Não foi possível abrir a impressão",Toast.LENGTH_LONG).show();
                }
            });
        } catch(Exception e) {
            runOnUiThread(() -> Toast.makeText(this,"Não foi possível preparar o PDF",Toast.LENGTH_LONG).show());
        }
    }
    @Override protected void onActivityResult(int requestCode,int resultCode,Intent data) {
        super.onActivityResult(requestCode,resultCode,data);
        if (requestCode==SAVE_CSV && resultCode==RESULT_OK && data!=null && pendingCsv!=null) {
            try {
                String payload=pendingCsv.substring(pendingCsv.indexOf(',')+1);
                byte[] bytes=Base64.decode(payload,Base64.DEFAULT);
                try(OutputStream out=getContentResolver().openOutputStream(data.getData())) {
                    if (out==null) throw new Exception("Erro ao abrir arquivo");
                    out.write(bytes);
                }
                Toast.makeText(this,"Relatório salvo",Toast.LENGTH_LONG).show();
            } catch(Exception e) {Toast.makeText(this,"Não foi possível salvar o relatório",Toast.LENGTH_LONG).show();}
        }
        if (requestCode==SAVE_CSV) pendingCsv=null;
    }
    private void showConnectionError() {
        if (mainFrame==null) return;
        LinearLayout overlay=vertical(); overlay.setPadding(dp(24),dp(50),dp(24),dp(25));
        overlay.setGravity(Gravity.CENTER); overlay.setBackgroundColor(NAVY);
        TextView title=text("Sem conexão com o servidor",23,Color.WHITE,true);
        title.setGravity(Gravity.CENTER); overlay.addView(title);
        TextView subtitle=text("Confira sua internet, o endereço HTTPS e se o servidor ObraPonto está funcionando.",14,0xffb6c6dd,false);
        subtitle.setGravity(Gravity.CENTER); subtitle.setPadding(0,dp(16),0,dp(22));overlay.addView(subtitle);
        Button retry=new Button(this);retry.setText("Tentar novamente");retry.setTextColor(NAVY);retry.setBackground(bg(MINT,12));
        overlay.addView(retry,new LinearLayout.LayoutParams(-1,dp(50)));
        retry.setOnClickListener(v->{mainFrame.removeView(overlay);displayError=false;if(webView!=null)webView.loadUrl(origin+APP_ROUTE);});
        Button edit=new Button(this);edit.setText("Alterar servidor");edit.setTextColor(Color.WHITE);edit.setBackground(bg(CARD,12));
        LinearLayout.LayoutParams ep=new LinearLayout.LayoutParams(-1,dp(50));ep.topMargin=dp(10);overlay.addView(edit,ep);
        edit.setOnClickListener(v->showSetup(true));
        mainFrame.addView(overlay,new FrameLayout.LayoutParams(-1,-1));
    }
    @Override public void onBackPressed() {
        if(webView!=null && webView.canGoBack())webView.goBack();else super.onBackPressed();
    }
    @Override public void onDestroy(){
        if(webView!=null){if(webView.getParent() instanceof ViewGroup)((ViewGroup)webView.getParent()).removeView(webView);webView.destroy();webView=null;}
        super.onDestroy();
    }
}
