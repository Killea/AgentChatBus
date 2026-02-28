# 测试Copilot CLI的session功能

Write-Host "=== 测试1: 获取Session ID ===" -ForegroundColor Green

# 创建一个临时文件存储输出
$tempFile = [System.IO.Path]::GetTempFileName()

# 尝试启动copilot并捕获输出
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "copilot"
$psi.Arguments = @('-i', '你可以告诉我你的session id吗，我想下次恢复这个session')
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
$psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
$psi.CreateNoWindow = $true

try {
    $process = [System.Diagnostics.Process]::Start($psi)
    
    # 读取输出流
    $stdOut = $process.StandardOutput
    $stdErr = $process.StandardError
    
    # 等待最多10秒
    $completed = $process.WaitForExit(10000)
    
    if ($completed) {
        Write-Host "进程正常退出" -ForegroundColor Green
        $output = $stdOut.ReadToEnd()
        $error = $stdErr.ReadToEnd()
        
        Write-Host "标准输出:" -ForegroundColor Yellow
        Write-Host $output
        
        if ($error) {
            Write-Host "错误输出:" -ForegroundColor Yellow
            Write-Host $error
        }
    } else {
        Write-Host "进程超时，强制杀死" -ForegroundColor Yellow
        $process.Kill()
        $output = $stdOut.ReadToEnd()
        Write-Host "捕获到的部分输出:" -ForegroundColor Yellow
        Write-Host $output
    }
} catch {
    Write-Host "错误: $_" -ForegroundColor Red
}
