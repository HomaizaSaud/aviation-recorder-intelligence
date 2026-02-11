import torch
ckpt = torch.load('python_model/emotion_detection/best.pt', map_location='cpu')
print('Number of classes:', ckpt['args']['output_class_num'] if 'args' in ckpt and 'output_class_num' in ckpt['args'] else 'unknown')
print('Finetune method:', ckpt['args'].get('finetune_method', 'unknown'))
print('Dataset:', ckpt['args'].get('dataset', 'unknown'))
