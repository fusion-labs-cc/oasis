
import requests
import os
import re
import m3u8
from config import headers
from crawler import prepareCrawl
from merge import mergeMp4
from delete import deleteM3u8, deleteMp4
from encode import ffmpegEncode
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from site_config import (
    detect_site, get_video_name, get_m3u8_url,
    setup_driver_for_site, wait_for_page_load,
    get_request_headers, resolve_m3u8_to_stream, build_ts_url
)

_active_driver = None
_active_folder_path = None

def download(url):
  global _active_driver, _active_folder_path
  encode = 1 #不轉檔
#   action = input('要轉檔嗎?[y/n]')
#   if action.lower() == 'y':
#     action = input('選擇轉檔方案[1:僅轉換格式(默認,推薦) 2:NVIDIA GPU 轉檔 3:CPU 轉檔]')
#     if action == '2':
#        encode = 2 #GPU轉檔
#     elif action == '3':
#        encode = 3 #CPU轉檔
#     else:
#        encode = 1 #快速無損轉檔

  # 依 URL 選出對應的站台 adapter（使用者自備，見 backend/sites.example.json）
  adapter = detect_site(url)
  print(f'偵測到站台: {adapter.get("name", adapter.get("id"))}')
  print('正在下載影片: ' + url)

  # 建立影片資料夾（movies/ 位於 repo root，即 backend 的上一層）
  media_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
  movies_folder = os.path.join(media_root, 'movies')
  if not os.path.exists(movies_folder):
      os.makedirs(movies_folder)

  #配置Selenium參數
  options = Options()
  options.add_argument('--no-sandbox')
  options.add_argument('--disable-dev-shm-usage')
  options.add_argument('--disable-extensions')
  options.add_argument('--headless')
  options.add_argument('--disable-gpu')
  options.add_argument('--log-level=3')
  options.add_argument("user-agent=Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/84.0.4147.125 Safari/537.36")
  options.add_experimental_option('excludeSwitches', ['enable-logging', 'enable-automation'])

  # 套用網站特定的 driver 設定
  options = setup_driver_for_site(options, adapter)

  service = Service(log_path=os.devnull)
  dr = webdriver.Chrome(options=options, service=service)
  _active_driver = dr
  try:
      dr.get(url)

      # 等待頁面載入
      wait_for_page_load(dr, adapter)

      # 找到影片名稱（使用網站特定的選擇器）
      video_name = get_video_name(dr, adapter)
      print(f'影片名稱: {video_name}')

      dirPath = os.path.join(movies_folder, video_name)
      if os.path.exists(os.path.join(movies_folder, f'{video_name}.mp4')):
        print('影片已存在, 跳過...')
        return
      if not os.path.exists(dirPath):
          os.makedirs(dirPath)
      folderPath = dirPath
      _active_folder_path = folderPath

      # 取得 m3u8 網址（使用網站特定的方法）
      m3u8url = get_m3u8_url(dr, adapter)
      print(f'm3u8url: {m3u8url}')

      # 取得下載用的 HTTP 標頭（含 Referer 等）
      dl_headers = get_request_headers(adapter, video_page_url=url)

      # 處理主播放清單 → 取得實際串流播放清單
      stream_m3u8url = resolve_m3u8_to_stream(m3u8url, dl_headers)

      # 得到串流 m3u8 的基底網址
      m3u8urlList = stream_m3u8url.split('/')
      m3u8urlList.pop(-1)
      downloadurl = '/'.join(m3u8urlList)

      # 下載串流 m3u8 檔案（使用 requests 帶標頭）
      m3u8file = os.path.join(folderPath, video_name + '.m3u8')
      response = requests.get(stream_m3u8url, headers=dl_headers, timeout=15)
      response.raise_for_status()
      with open(m3u8file, 'wb') as f:
          f.write(response.content)

      # 得到 m3u8 file裡的 URI和 IV
      m3u8obj = m3u8.load(m3u8file)
      m3u8uri = ''
      m3u8iv = ''

      for key in m3u8obj.keys:
          if key:
              m3u8uri = key.uri
              m3u8iv = key.iv

      # 儲存 ts網址 in tsList（處理絕對/相對 URL）
      tsList = []
      for seg in m3u8obj.segments:
          tsUrl = build_ts_url(seg.uri, downloadurl)
          tsList.append(tsUrl)

      # 有加密
      if m3u8uri:
          m3u8keyurl = build_ts_url(m3u8uri, downloadurl)
          response = requests.get(m3u8keyurl, headers=dl_headers, timeout=10)
          contentKey = response.content
          iv = m3u8iv.replace("0x", "")[:16].encode()
      else:
          contentKey = None
          iv = None
  finally:
      dr.quit()
      _active_driver = None

  # 刪除m3u8 file
  deleteM3u8(folderPath)

  # 開始爬蟲並下載mp4片段至資料夾（傳入下載用標頭）
  prepareCrawl(contentKey, iv, folderPath, tsList, dl_headers)

  # 合成mp4
  mergeMp4(folderPath, tsList)

  # 刪除子mp4
  deleteMp4(folderPath)

  # 轉檔
  ffmpegEncode(folderPath, video_name, encode)

  # 移出資料夾並刪除資料夾
  src = os.path.join(folderPath, f'{video_name}.mp4')
  dst = os.path.join(movies_folder, f'{video_name}.mp4')
  os.rename(src, dst)
  os.rmdir(folderPath)
  print(f'✅ 影片已移至: {dst}')
