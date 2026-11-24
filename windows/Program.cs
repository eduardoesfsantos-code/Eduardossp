using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ObraPontoEmpresaWindows;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new MainWindow());
    }
}

public sealed class MainWindow : Form
{
    private const string Origin = "https://obraponto-servidor-production.up.railway.app";
    private const string PanelUrl = Origin + "/admin/";
    private readonly WebView2 browser = new() { Dock = DockStyle.Fill };
    private readonly Label status = new()
    {
        Text = "Conectando ao ObraPonto...",
        AutoSize = true,
        ForeColor = Color.FromArgb(207, 222, 240),
        Margin = new Padding(12, 12, 8, 0)
    };

    public MainWindow()
    {
        Text = "ObraPonto Empresa | Painel administrativo";
        Width = 1280;
        Height = 800;
        MinimumSize = new Size(780, 550);
        StartPosition = FormStartPosition.CenterScreen;

        var toolbar = new FlowLayoutPanel
        {
            Dock = DockStyle.Top,
            Height = 48,
            AutoSize = false,
            BackColor = Color.FromArgb(14, 25, 45),
            Padding = new Padding(10, 4, 0, 0),
            WrapContents = false
        };
        var home = ActionButton("Início", () => Navigate(PanelUrl));
        var back = ActionButton("Voltar", () => { if (browser.CanGoBack) browser.GoBack(); });
        var refresh = ActionButton("Atualizar", () => browser.Reload());
        var external = ActionButton("Abrir no navegador", () => OpenExternal(PanelUrl));
        toolbar.Controls.Add(home);
        toolbar.Controls.Add(back);
        toolbar.Controls.Add(refresh);
        toolbar.Controls.Add(external);
        toolbar.Controls.Add(status);
        Controls.Add(browser);
        Controls.Add(toolbar);
        Shown += async (_, _) => await StartBrowserAsync();
    }

    private static Button ActionButton(string text, Action handler)
    {
        var button = new Button
        {
            Text = text,
            AutoSize = true,
            Height = 32,
            FlatStyle = FlatStyle.Flat,
            ForeColor = Color.White,
            BackColor = Color.FromArgb(47, 65, 100),
            Margin = new Padding(4, 3, 4, 3)
        };
        button.FlatAppearance.BorderSize = 0;
        button.Click += (_, _) => handler();
        return button;
    }

    private void Navigate(string address)
    {
        if (browser.CoreWebView2 != null) browser.CoreWebView2.Navigate(address);
    }

    private static void OpenExternal(string? url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return;
        if (uri.Scheme is not ("https" or "mailto" or "tel")) return;
        try { Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true }); }
        catch { }
    }

    private async Task StartBrowserAsync()
    {
        try
        {
            var dataDirectory = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "ObraPonto", "Empresa");
            Directory.CreateDirectory(dataDirectory);
            var environment = await CoreWebView2Environment.CreateAsync(null, dataDirectory);
            await browser.EnsureCoreWebView2Async(environment);
            browser.CoreWebView2.Settings.AreDevToolsEnabled = false;
            browser.CoreWebView2.Settings.IsStatusBarEnabled = false;
            browser.CoreWebView2.NewWindowRequested += (_, e) =>
            {
                e.Handled = true;
                OpenExternal(e.Uri);
            };
            browser.CoreWebView2.NavigationStarting += (_, e) =>
            {
                if (e.Uri.StartsWith(Origin + "/", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(e.Uri, Origin, StringComparison.OrdinalIgnoreCase)) return;
                e.Cancel = true;
                OpenExternal(e.Uri);
            };
            browser.CoreWebView2.NavigationCompleted += (_, e) =>
            {
                status.Text = e.IsSuccess ? "Servidor conectado" : "Falha de conexão — tente Atualizar";
            };
            Navigate(PanelUrl);
        }
        catch (Exception ex)
        {
            status.Text = "Não foi possível abrir o painel.";
            MessageBox.Show(this,
                "O ObraPonto precisa do Microsoft Edge WebView2 Runtime instalado.\n"
                + "Atualize o Windows ou instale o WebView2 da Microsoft.\n\n"
                + ex.Message,
                "ObraPonto Empresa", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }
}
