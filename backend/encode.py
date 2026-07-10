import os
import subprocess
def ffmpegEncode(folder_path, file_name, action):
    if action == 0: #不轉檔
        return

    src = os.path.join(folder_path, f'{file_name}.mp4')
    tmp = os.path.join(folder_path, f'f_{file_name}.mp4')

    if action == 1: #快速無損轉檔
        try:
            subprocess.call(['ffmpeg', '-i', src,
                             '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart',
                             tmp], cwd=folder_path)
            os.remove(src)
            os.rename(tmp, src)
            print("轉檔成功!")

        except:
            print("轉檔失敗!")
    elif action == 2: #GPU轉檔
        try:
            subprocess.call(['ffmpeg', '-i', src, '-c:v', 'h264_nvenc', '-b:v', '10000K',
                                '-threads', '5', tmp], cwd=folder_path)
            os.remove(src)
            os.rename(tmp, src)
            print("轉檔成功!")

        except:
            print("轉檔失敗!")
    elif action == 3: #CPU轉檔
        try:
            subprocess.call(['ffmpeg', '-i', src, '-c:v', 'libx264', '-b:v', '3M',
                            '-threads', '5', '-preset', 'superfast', tmp], cwd=folder_path)
            os.remove(src)
            os.rename(tmp, src)
            print("轉檔成功!")

        except:
            print("轉檔失敗!")
    else:
        return
