import { describe, expect, test } from "bun:test"
import { renderizarMarkdown } from "../web/markdown.js"

describe("renderizarMarkdown: subconjunto de Markdown", () => {
  test("una tabla se convierte en <table> con encabezado y filas", () => {
    const html = renderizarMarkdown("| campo | valor |\n|---|---|\n| valor | 1500 |\n| fecha_fin | 2099-12-31 |")
    expect(html).toContain("<table>")
    expect(html).toContain("<th>campo</th><th>valor</th>")
    expect(html).toContain("<tr><td>fecha_fin</td><td>2099-12-31</td></tr>")
    expect(html).toStartWith('<div class="tabla">')
  })

  test("**x** → <strong>, `x` → <code> sin procesar su interior", () => {
    expect(renderizarMarkdown("Esto es **importante**")).toBe("<p>Esto es <strong>importante</strong></p>")
    expect(renderizarMarkdown("usa `**literal**`")).toBe("<p>usa <code>**literal**</code></p>")
  })

  test("títulos, listas, línea horizontal y párrafos con salto de línea", () => {
    const html = renderizarMarkdown("# Título\n- uno\n- dos\n\n1. primero\n2. segundo\n\n---\nlínea 1\nlínea 2")
    expect(html).toContain("<h3>Título</h3>")
    expect(html).toContain("<ul><li>uno</li><li>dos</li></ul>")
    expect(html).toContain("<ol><li>primero</li><li>segundo</li></ol>")
    expect(html).toContain("<hr>")
    expect(html).toContain("<p>línea 1<br>línea 2</p>")
  })

  test("una barra escapada \\| queda dentro de la celda", () => {
    expect(renderizarMarkdown("| cliente |\n|---|\n| A\\|B |")).toContain("<td>A|B</td>")
  })
})

describe("renderizarMarkdown: seguridad (escapar → convertir)", () => {
  test("<script> y <img onerror> quedan escapados", () => {
    const html = renderizarMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n| a |\n|---|\n| <script>x</script> |')
    expect(html).not.toContain("<script")
    expect(html).not.toContain("<img")
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;")
  })

  test("un enlace Markdown no se convierte en <a>, y las comillas se escapan", () => {
    const html = renderizarMarkdown('[haz clic](javascript:alert(1)) "comillas" \'simples\'')
    expect(html).not.toContain("<a")
    expect(html).toContain("[haz clic](javascript:alert(1))")
    expect(html).toContain("&quot;comillas&quot; &#39;simples&#39;")
  })

  test("la negrita no permite inyectar etiquetas", () => {
    expect(renderizarMarkdown("**<b onclick=x>hola</b>**")).toBe("<p><strong>&lt;b onclick=x&gt;hola&lt;/b&gt;</strong></p>")
  })
})
